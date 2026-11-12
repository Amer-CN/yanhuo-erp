// 云同步：本地优先 + 发件箱推送 + 增量拉取。
// 后端：Supabase（PostgREST）。配置只存 localStorage，不写进会被同步的设置表。

import { db } from './db';
import { loadAll } from './repo';
import {
  SKIP_SETTINGS,
  UNKNOWN_KINDS_KEY,
  enqueueAllLocal,
  enqueueMany,
  pendingCount,
  syncWanted
} from './outbox';
import { DEFAULT_SYNC } from './syncDefaults';
import { mergeSessionPair } from './sessionLogic';
import { businessTime, resolveRemote } from './syncResolve';
import { canonicalJson } from './canonical';
import { fenToStr, isoToLocalDate, isoToTime, localDate } from './util';
import type { OutboxRow, SyncConflictRow } from './db';
import type { Table } from 'dexie';
import type { SaleLine, Session } from './types';

export interface SyncConfig {
  url: string;
  anonKey: string;
  ledgerKey: string;
}

export interface SyncStatus {
  configured: boolean;
  online: boolean;
  syncing: boolean;
  pending: number;
  lastSyncAt: number | null;
  error: string | null;
}

const LS = {
  url: 'yh-sync-url',
  anonKey: 'yh-sync-anon',
  ledger: 'yh-sync-ledger',
  lastPull: 'yh-sync-last-pull',
  /** 复合游标的第二列：与 lastPull 一起定位「拉到哪里了」 */
  lastPullId: 'yh-sync-last-pull-id',
  /** 已处理过的「清空账本」标记值；标记换了新值就整库重放一次 */
  clearedAt: 'yh-sync-cleared-at',
  /** 上次「每日首次全量重放」的**本地日期**（yyyy-mm-dd，见 `localDate()`） */
  lastReplay: 'yh-sync-last-replay',
  /**
   * 每日重放的**续扫游标**（JSON `{ts,id}`）。
   *
   * 账本超过 `MAX_PAGES × PAGE_SIZE` 行时一轮重放扫不完。没有这个游标就只能每轮从 0 重来：
   * 前 1 万行每轮白扫一遍，第 1 万行之后的旧数据永远轮不到（见 H-1）。有它就能跨轮续扫。
   */
  lastReplayCursor: 'yh-sync-last-replay-cursor',
  lastSync: 'yh-sync-last-sync',
  error: 'yh-sync-error',
  warn: 'yh-sync-warn',
  disabled: 'yh-sync-disabled'
};

/**
 * 「清空账本」标记行 id 的前缀。
 * 清空是绝对操作，不能只靠 updated_at 水位传播：另一台设备时钟偏快时，
 * 它的水位会高于 tombstone 的 updated_at，那些行永远落在水位以下（且不会自愈）。
 * 所以清空后额外写一条固定 id 的标记行，其它设备看到标记值变化就整库重放一次。
 */
const CLEAR_MARKER_PREFIX = '__ledger_cleared__';
/** 标记行的 kind：不属于任何业务类型，pull 侧会整行过滤，不会写进业务表 */
const CLEAR_MARKER_KIND = 'ledger';

// 设备身份 / 本机操作人 / 设备级诊断不参与云同步：名单见 `outbox.SKIP_SETTINGS`。
// 放在 outbox 是为了让入队处也能用同一份名单（L-2：不该同步的键连发件箱都不进）。

/** 一次推送的发件箱批量上限 */
const OUTBOX_BATCH = 300;
/** 单次同步的重试次数 */
const MAX_ATTEMPTS = 4;
/** 拉取分页的最大页数 */
const MAX_PAGES = 20;
/** 拉取分页的页大小 */
const PAGE_SIZE = 500;
/** 错误响应文本的截断长度 */
const ERROR_SNIPPET_LEN = 300;
/** 单次 HTTP 请求的超时（毫秒）：弱网下避免连接挂住、把 busy 锁死在「同步中」 */
const REQUEST_TIMEOUT_MS = 15_000;
/** 未知 kind 最多保留的 id 数（只表示条数，不表方向） */
const UNKNOWN_KIND_KEEP = 20;
/** 非法远端行诊断最多保留的条数 */
const INVALID_REMOTE_KEEP = 20;

/**
 * 拉取重叠窗口（毫秒）。
 *
 * 云端 `updated_at` 由**推送端**的 `Date.now()` 生成，而本地水位同样来自这些客户端时间戳
 * （包含本机自己推上去的行）。设 B 的时钟比 A 快 Δ：B 推送后水位 ≈「未来时间」，
 * A 在 Δ 内推送的行时间戳低于水位，**永远不会被 B 拉到**，且水位只会上涨、不会自愈。
 *
 * 本机不是推送侧、无法改服务端时间（不改 `supabase/schema.sql`），所以采用过渡方案：
 * 每轮拉取的**起点**回退 `OVERLAP_MS` 重放一小段，用重叠窗口吸收设备时钟偏斜；
 * 重复应用由 `applyRemoteBatch` 的幂等写（bulkPut / delete）吸收，代价只是多扫几行。
 *
 * 注意：重叠只作用于「本轮第一个请求的起点」。持久化游标仍按真实行尾推进
 * （见 `nextCursor` / `setLastPullCursor`），绝不能把回退后的起点写回游标，
 * 否则每轮都会重复拉同一段、永远推进不了。
 */
const OVERLAP_MS = 5 * 60 * 1000;

/**
 * 回推节流（毫秒）：同一记录在该时间内最多回推一次。
 * 两台设备互判「本地较新」时若每轮都回推，会变成无限对推（互相喂数据、互相触发同步）。
 */
const REPUSH_THROTTLE_MS = 30_000;
/** 回推节流表的清理阈值：超过后清掉已过期的键，避免长期运行后 Map 无界增长 */
const REPUSH_PRUNE_AT = 500;
/**
 * 单轮回推上限。
 *
 * 重放轮现在也会回推（M-1），第一次全量重放可能一次命中大量 `keep-local`；
 * 每轮只推这么多，剩下的下一轮继续推（节流表只在成功入队后才记，未选中的下一轮立刻就能推），
 * 避免一次把发件箱灌进上千行、把推送队列堵住。
 */
const REPUSH_MAX_PER_PASS = 200;

export function getSyncConfig(): SyncConfig | null {
  try {
    if (localStorage.getItem(LS.disabled) === '1') return null;

    const url = localStorage.getItem(LS.url)?.trim().replace(/\/+$/, '');
    const anonKey = localStorage.getItem(LS.anonKey)?.trim();
    const ledgerKey = localStorage.getItem(LS.ledger)?.trim();
    if (url && anonKey && ledgerKey) return { url, anonKey, ledgerKey };

    // 没手动配置就用内置配置：打开即同步，零设置
    if (DEFAULT_SYNC.url && DEFAULT_SYNC.anonKey && DEFAULT_SYNC.ledgerKey) {
      return {
        url: DEFAULT_SYNC.url,
        anonKey: DEFAULT_SYNC.anonKey,
        ledgerKey: DEFAULT_SYNC.ledgerKey
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function isDefaultSyncConfig(): boolean {
  const cfg = getSyncConfig();
  return Boolean(
    cfg &&
      cfg.url === DEFAULT_SYNC.url &&
      cfg.anonKey === DEFAULT_SYNC.anonKey &&
      cfg.ledgerKey === DEFAULT_SYNC.ledgerKey
  );
}

export function saveSyncConfig(cfg: SyncConfig): void {
  localStorage.setItem(LS.url, cfg.url.trim().replace(/\/+$/, ''));
  localStorage.setItem(LS.anonKey, cfg.anonKey.trim());
  localStorage.setItem(LS.ledger, cfg.ledgerKey.trim());
  localStorage.removeItem(LS.disabled);
}

export function clearSyncConfig(): void {
  localStorage.removeItem(LS.url);
  localStorage.removeItem(LS.anonKey);
  localStorage.removeItem(LS.ledger);
  localStorage.removeItem(LS.lastPull);
  localStorage.removeItem(LS.lastPullId);
  localStorage.removeItem(LS.clearedAt);
  localStorage.removeItem(LS.lastReplay);
  localStorage.removeItem(LS.lastReplayCursor);
  localStorage.removeItem(LS.lastSync);
  localStorage.removeItem(LS.error);
  localStorage.setItem(LS.disabled, '1');
}

export function makeLedgerKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function lastPullAt(): number {
  return Number(localStorage.getItem(LS.lastPull) ?? 0) || 0;
}

function lastPullId(): string {
  return localStorage.getItem(LS.lastPullId) ?? '';
}

/** 持久化复合游标：时间水位沿用旧键，id 存新键（老版本只读旧键，不受影响） */
function setLastPullCursor(cursor: PullCursor): void {
  localStorage.setItem(LS.lastPull, String(cursor.ts));
  localStorage.setItem(LS.lastPullId, cursor.id);
}

function clearedMark(): number {
  return Number(localStorage.getItem(LS.clearedAt) ?? 0) || 0;
}

/** 上次「每日首次全量重放」的本地日期；没做过返回 null */
function lastReplayDate(): string | null {
  return localStorage.getItem(LS.lastReplay);
}

/** 落「今天已重放」标记；隐私模式（localStorage 抛错）忽略，最多是下次多扫一轮 */
function setLastReplayDate(value: string): void {
  try {
    localStorage.setItem(LS.lastReplay, value);
  } catch {
    /* 隐私模式忽略 */
  }
}

/**
 * 重放的续扫游标：上一轮因页数配额用满而中断时，从扫到的位置接着扫。
 * 读不到 / 坏值一律当作「从 0 开始」——重放本身幂等，多扫一轮不会写坏数据。
 */
function lastReplayCursor(): PullCursor {
  try {
    const raw = localStorage.getItem(LS.lastReplayCursor);
    if (!raw) return { ts: 0, id: '' };
    const parsed = JSON.parse(raw) as { ts?: unknown; id?: unknown };
    return {
      ts: Number(parsed?.ts) || 0,
      id: typeof parsed?.id === 'string' ? parsed.id : ''
    };
  } catch {
    return { ts: 0, id: '' };
  }
}

function setLastReplayCursor(cursor: PullCursor): void {
  try {
    localStorage.setItem(LS.lastReplayCursor, JSON.stringify(cursor));
  } catch {
    /* 隐私模式忽略：退化成下次从 0 重扫，只多花请求，不写坏数据 */
  }
}

function clearLastReplayCursor(): void {
  try {
    localStorage.removeItem(LS.lastReplayCursor);
  } catch {
    /* 隐私模式忽略 */
  }
}

function setClearedMark(value: number): void {
  localStorage.setItem(LS.clearedAt, String(value));
}

/** 标记行 id 带上账本码：id 是远端主键，多个账本共用一张表时不能互相覆盖 */
function clearMarkerId(ledgerKey: string): string {
  return `${CLEAR_MARKER_PREFIX}:${ledgerKey}`;
}

/** 标记行只用于「通知其它设备重放」，绝不写业务表 */
function isClearMarkerRow(row: { id?: string }): boolean {
  return typeof row.id === 'string' && row.id.startsWith(`${CLEAR_MARKER_PREFIX}:`);
}

/** 取标记行里「这次清空」的值；data.clearedAt 缺失（旧格式）时退回 updated_at */
function clearMarkValue(row: { updated_at?: number; data?: unknown }): number {
  const data = row.data as { clearedAt?: unknown } | null | undefined;
  const fromData = Number(data?.clearedAt);
  if (Number.isFinite(fromData) && fromData > 0) return fromData;
  return Number(row.updated_at) || 0;
}

/** 降级提示写一次诊断键；隐私模式（localStorage 抛错）忽略 */
function warnDegraded(text: string): void {
  try {
    localStorage.setItem(LS.warn, text);
  } catch {
    /* 隐私模式忽略 */
  }
}

/**
 * 非法远端行诊断：与 `warnDegraded` 共用 `yh-sync-warn` 键，按行累计、**最多保留 20 条**。
 * 每条都带 `kind:recordId`，设置页把该键原样展示，发现脏数据时能直接在控制台定位行。
 * 诊断本身绝不影响同步（写不进去就静默跳过）。
 */
function warnInvalidRemote(kind: string, recordId: string): void {
  appendWarn(`拉取到非法数据已跳过：${kind}:${recordId}`);
}

/** 追加一条诊断（按行去重、最多 20 条）；隐私模式忽略 */
function appendWarn(line: string): void {
  try {
    const prev = localStorage.getItem(LS.warn) ?? '';
    const items = prev ? prev.split('\n') : [];
    if (items.includes(line)) return;
    items.push(line);
    localStorage.setItem(LS.warn, items.slice(-INVALID_REMOTE_KEEP).join('\n'));
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 同一类提示只保留最新一条：每轮同步都会写，整表追加会把真正要看的非法行挤掉 */
function replaceWarnByPrefix(prefix: string, line: string): void {
  try {
    const prev = localStorage.getItem(LS.warn) ?? '';
    const items = prev ? prev.split('\n').filter((l) => !l.startsWith(prefix)) : [];
    items.push(line);
    localStorage.setItem(LS.warn, items.slice(-INVALID_REMOTE_KEEP).join('\n'));
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 删掉某一类提示（条件已不成立时用，避免设置页挂着过期告警） */
function clearWarnByPrefix(prefix: string): void {
  try {
    const prev = localStorage.getItem(LS.warn) ?? '';
    if (!prev) return;
    const items = prev.split('\n').filter((l) => !l.startsWith(prefix));
    if (items.length === 0) localStorage.removeItem(LS.warn);
    else localStorage.setItem(LS.warn, items.join('\n'));
  } catch {
    /* 隐私模式忽略 */
  }
}

const WARN_SKIPPED_PREFIX = '本轮拉取有 ';
const WARN_REPLAY_PREFIX = '全量校对本轮未完成';

/**
 * 拉取侧「没落到业务表」的行数诊断（L-4）。
 *
 * `pulled` 以前按「读到的行数」累加，pending（本地待推送）与非法行都被算进去，
 * 排查「为什么没看到这条」时会被日志误导。现在两者单独计数写在这里。
 * 归零时把旧提示删掉，避免设置页一直挂着过期的告警。
 */
function warnSkippedRows(skippedPending: number, skippedInvalid: number): void {
  const total = skippedPending + skippedInvalid;
  if (total === 0) {
    clearWarnByPrefix(WARN_SKIPPED_PREFIX);
    return;
  }
  replaceWarnByPrefix(
    WARN_SKIPPED_PREFIX,
    `${WARN_SKIPPED_PREFIX}${total} 行未应用（本地待推送 ${skippedPending} 行 / 非法 ${skippedInvalid} 行）`
  );
}

/** 账本超过一页配额、本轮全量校对没扫完：写一条可见诊断，别让它静默（H-1） */
function warnReplayIncomplete(scannedAt: number): void {
  replaceWarnByPrefix(
    WARN_REPLAY_PREFIX,
    `${WARN_REPLAY_PREFIX}：数据量大，已扫至 ${scannedAt}，下次同步继续`
  );
}

export function lastSyncAt(): number | null {
  const v = Number(localStorage.getItem(LS.lastSync) ?? 0);
  return v || null;
}

export function lastSyncError(): string | null {
  return localStorage.getItem(LS.error);
}

/* ------------------------------------------------------------------ REST */

async function rest<T = unknown>(
  cfg: SyncConfig,
  path: string,
  init?: RequestInit
): Promise<T> {
  const controller = new AbortController();
  const timer: ReturnType<typeof setTimeout> = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );
  try {
    const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        apikey: cfg.anonKey,
        // 旧版 anon key 是 JWT（eyJ...），新 publishable key 不是 JWT，
        // 后者只放在 apikey 头里，避免被 PostgREST 当成坏 token。
        ...(cfg.anonKey.startsWith('eyJ') ? { Authorization: `Bearer ${cfg.anonKey}` } : {}),
        'Content-Type': 'application/json',
        'x-ledger-key': cfg.ledgerKey,
        ...(init?.headers ?? {})
      }
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, ERROR_SNIPPET_LEN);
      throw new Error(`Supabase ${res.status}: ${text}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  } catch (e) {
    // 超时统一转成可读文案：调用方（useSync）会按退避重试，不会静默挂住
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error('云端无响应（超时），稍后自动重试');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ 记录映射 */

type Kind = 'product' | 'batch' | 'order' | 'line' | 'adjustment' | 'session' | 'setting';

/** 记录类型 → 本地表；同步的读写按类型批量合并，避免逐条往返。 */
const TABLE_BY_KIND: Record<Kind, Table<any, any>> = {
  product: db.products,
  batch: db.batches,
  order: db.orders,
  line: db.lines,
  adjustment: db.adjustments,
  session: db.sessions,
  setting: db.settings
};

const KNOWN_KINDS = new Set<Kind>(Object.keys(TABLE_BY_KIND) as Kind[]);

const RECORD_TABLES = [
  db.products,
  db.batches,
  db.orders,
  db.lines,
  db.adjustments,
  db.sessions,
  db.settings
];

/** 一次事务内按类型批量读取本地记录；缺失的 id 不放进结果。 */
async function getLocalMany(
  rows: { kind: Kind; recordId: string }[]
): Promise<Map<string, unknown>> {
  const idsByKind = new Map<Kind, string[]>();
  for (const row of rows) {
    if (row.kind === 'setting' && SKIP_SETTINGS.has(row.recordId)) continue;
    const ids = idsByKind.get(row.kind) ?? [];
    ids.push(row.recordId);
    idsByKind.set(row.kind, ids);
  }

  const found = new Map<string, unknown>();
  if (idsByKind.size === 0) return found;
  await db.transaction('r', RECORD_TABLES, async () => {
    for (const [kind, ids] of idsByKind) {
      const locals = await TABLE_BY_KIND[kind].bulkGet(ids);
      ids.forEach((id, i) => {
        if (locals[i] !== undefined) found.set(`${kind}:${id}`, locals[i]);
      });
    }
  });
  return found;
}

interface RemoteRow {
  id: string;
  record_id: string;
  kind: Kind;
  data: unknown;
  updated_at: number;
  /** 业务修改时间（毫秒）；远端没加该列时拉取会降级为不含该列的列清单，此处缺省 */
  record_updated_at?: number;
  deleted: boolean;
}

interface PushRow {
  id: string;
  record_id: string;
  ledger: string;
  kind: Kind;
  data: unknown;
  updated_at: number;
  record_updated_at?: number;
  schema_version?: number;
  device_id: string;
  deleted: boolean;
}

/** record_updated_at / schema_version 列在当前远端缺失时降级为旧格式（只提示一次） */
let recordColumnMissing = false;
let schemaColumnMissing = false;

/** PGRST204 表示列不存在；按错误文本判断缺的是哪一列 */
function missingColumns(e: unknown): 'record' | 'schema' | 'both' | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes('PGRST204')) return null;
  const record = msg.includes('record_updated_at');
  const schema = msg.includes('schema_version');
  if (record && schema) return 'both';
  if (record) return 'record';
  if (schema) return 'schema';
  return 'both';
}

function stripMissingColumns(rows: PushRow[]): PushRow[] {
  return rows.map((row) => {
    const copy = { ...row };
    if (recordColumnMissing) delete copy.record_updated_at;
    if (schemaColumnMissing) delete copy.schema_version;
    return copy;
  });
}

async function postPayload(cfg: SyncConfig, rows: PushRow[]): Promise<void> {
  await rest(cfg, 'yh_records?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows)
  });
}

/** 按发件箱行组装推送 payload；本地缺失/删除的统一标 deleted */
function buildPushPayload(
  rows: OutboxRow[],
  locals: Map<string, unknown>,
  cfg: SyncConfig,
  deviceId: string
): PushRow[] {
  const payload: PushRow[] = [];

  for (const row of rows) {
    if (row.kind === 'setting' && SKIP_SETTINGS.has(row.recordId)) continue;
    const local = row.op === 'delete' ? undefined : locals.get(`${row.kind}:${row.recordId}`);
    const payloadRow: PushRow = {
      id: `${row.kind}:${row.recordId}`,
      record_id: row.recordId,
      ledger: cfg.ledgerKey,
      kind: row.kind,
      data: local ?? {},
      // 推送时刻只做增量水位；业务时间单独放 record_updated_at
      updated_at: Date.now(),
      device_id: deviceId,
      deleted: row.op === 'delete' || !local
    };
    // 已确认远端缺列后，后续批次直接从 payload 里省掉，避免每次都先撞一次 400
    if (!recordColumnMissing) {
      payloadRow.record_updated_at = local ? businessTime(local) : 0;
    }
    if (!schemaColumnMissing) payloadRow.schema_version = 2;
    payload.push(payloadRow);
  }
  return payload;
}

/** 推送 payload：缺列时降级重试；重试次数与缺列标志位的语义保持不变 */
async function postWithSchemaFallback(cfg: SyncConfig, payload: PushRow[]): Promise<void> {
  if (payload.length === 0) return;
  let rowsToSend = payload;
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    try {
      await postPayload(cfg, rowsToSend);
      break;
    } catch (e) {
      const missing = missingColumns(e);
      if (!missing) throw e;

      const before = `${recordColumnMissing}/${schemaColumnMissing}`;
      if (missing === 'record' || missing === 'both') recordColumnMissing = true;
      if (missing === 'schema' || missing === 'both') schemaColumnMissing = true;
      if (`${recordColumnMissing}/${schemaColumnMissing}` === before) throw e;

      warnDegraded('远端缺少 record_updated_at 或 schema_version 列，已降级推送');
      rowsToSend = stripMissingColumns(payload);
      if (attempts >= MAX_ATTEMPTS) throw e;
    }
  }
}

async function pushOutbox(cfg: SyncConfig, deviceId: string): Promise<number> {
  const rows = await db.outbox.orderBy('queuedAt').limit(OUTBOX_BATCH).toArray();
  if (rows.length === 0) return 0;

  // 一次事务批量取本地记录（原来是逐条 get，最多 300 次串行往返）
  const locals = await getLocalMany(
    rows
      .filter((row) => row.op !== 'delete')
      .map((row) => ({ kind: row.kind, recordId: row.recordId }))
  );

  const payload = buildPushPayload(rows, locals, cfg, deviceId);
  await postWithSchemaFallback(cfg, payload);
  await db.outbox.bulkDelete(rows.map((r) => r.id));
  return payload.length;
}

/**
 * 记录本机遇到的未知 kind（新版本客户端写入的记录），最多保留 20 条 id。
 * 不写入业务表、不删除远端行；水位仍按 updated_at 推进。
 */
async function mergeUnknownKinds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const prev = (await db.settings.get(UNKNOWN_KINDS_KEY))?.value;
  let arr: string[] = [];
  if (prev) {
    try {
      const parsed = JSON.parse(prev) as unknown;
      if (Array.isArray(parsed)) arr = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      /* 坏值按空数组处理 */
    }
  }
  const merged = [...new Set([...arr, ...ids])].slice(-UNKNOWN_KIND_KEEP);
  await db.settings.put({ key: UNKNOWN_KINDS_KEY, value: JSON.stringify(merged) });
}

/* ------------------------------------------------------ 远端 data 校验层 */

/**
 * 字段类型：`num` 有限数字 / `str` 字符串 / `bool` 布尔 / `obj` 普通对象。
 * 远端 `data` 是 `jsonb`（`supabase/schema.sql` 无任何约束），所以入站必须自己校验：
 * 一条 `amountFen: "abc"` 或 `qtyBase: -1e9` 的脏行会让整场报表变 `NaN`，
 * 而 `keep-local` 语义又让它不会被正确版本覆盖回**来自愈**。
 */
type FieldType = 'num' | 'str' | 'bool' | 'obj';

interface KindSchema {
  /** 必填字段：缺失或类型不符即判非法 */
  required: Record<string, FieldType>;
  /** 选填字段：缺失/`null` 放过（旧版本可能没写），存在则必须类型正确 */
  optional: Record<string, FieldType>;
}

/**
 * 各 kind 的最小可接受结构。只校验「身份 + 金额 + 数量」这些会被计算链路消费的字段，
 * 不做「字段全集」校验：新版本客户端可能加字段，多出来的字段原样保留（不丢数据）。
 */
const REMOTE_SCHEMAS: Record<Kind, KindSchema> = {
  order: {
    required: { deviceId: 'str', operator: 'str', createdAt: 'str', payMethod: 'str', totalFen: 'num' },
    optional: { sessionId: 'str', note: 'str', updatedAt: 'str', voided: 'bool' }
  },
  line: {
    required: { orderId: 'str', productId: 'str', qtyBase: 'num', amountFen: 'num' },
    optional: {
      unit: 'str',
      qty: 'num',
      listUnitPriceFen: 'num',
      unitPriceFen: 'num',
      discountFen: 'num',
      gift: 'bool',
      updatedAt: 'str'
    }
  },
  batch: {
    required: { productId: 'str', qtyBase: 'num', unitCostFen: 'num' },
    optional: {
      batchNo: 'str',
      produceDate: 'str',
      expiryDate: 'str',
      supplier: 'str',
      receivedAt: 'str',
      deviceId: 'str',
      createdAt: 'str',
      updatedAt: 'str'
    }
  },
  adjustment: {
    required: { productId: 'str', qtyBase: 'num', type: 'str' },
    optional: { reason: 'str', createdAt: 'str', deviceId: 'str', updatedAt: 'str' }
  },
  product: {
    required: { name: 'str', unitBase: 'str', priceList: 'num' },
    optional: {
      category: 'str',
      boxQty: 'num',
      negotiable: 'bool',
      sample: 'bool',
      archived: 'bool',
      sortOrder: 'num',
      createdAt: 'str',
      updatedAt: 'str'
    }
  },
  session: {
    required: { deviceId: 'str', startedAt: 'str', status: 'str', updatedAt: 'str' },
    optional: {
      closedAt: 'str',
      closedBy: 'str',
      openedBy: 'str',
      patchedCount: 'num',
      note: 'str',
      summary: 'obj'
    }
  },
  setting: {
    required: { key: 'str', value: 'str' },
    optional: {}
  }
};

/** 枚举字段：值域外的字符串同样按非法处理（避免把 'Cash' 这类脏值写进报表分支） */
const ENUM_FIELDS: Partial<Record<Kind, Record<string, readonly string[]>>> = {
  order: { payMethod: ['cash', 'wechat', 'alipay'] },
  line: { unit: ['box', 'base'] },
  session: { status: ['open', 'closed'] },
  adjustment: { type: ['return', 'loss', 'correction'] },
  product: { category: ['炮', '烟花', '儿童', '组合'] }
};

function matchFieldType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'num':
      // NaN / Infinity 会让金额链路整条变 NaN，必须挡在入库之前
      return typeof value === 'number' && Number.isFinite(value);
    case 'str':
      return typeof value === 'string';
    case 'bool':
      return typeof value === 'boolean';
    case 'obj':
      return isPlainObject(value);
    default:
      return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 数量/金额的业务合理性下限（不是精度校验，只挡掉明显会毁掉报表的取值）：
 * - 明细数量必须 > 0（`buildLines` 的写入侧门槛，入站保持同口径）；
 * - 金额、进货数量、单价、标价不得为负（调整量的符号由 `adjustment` 自己表达，不在这里限制）。
 */
function withinBounds(kind: Kind, obj: Record<string, unknown>): boolean {
  const num = (field: string) => obj[field] as number;
  switch (kind) {
    case 'line':
      return num('qtyBase') > 0 && num('amountFen') >= 0;
    case 'order':
      return num('totalFen') >= 0;
    case 'batch':
      return num('qtyBase') >= 0 && num('unitCostFen') >= 0;
    case 'product':
      return num('priceList') >= 0 && (obj.boxQty === undefined || num('boxQty') >= 0);
    default:
      return true;
  }
}

/**
 * 校验远端 `data` 并按 kind 返回可写入业务表的对象；非法返回 `null`（调用方跳过该行）。
 *
 * 规则：
 * - `data` 必须是**普通对象**：`null` / 数组 / 字符串 / 数字一律判非法（原先整体展开后 `bulkPut`
 *   会把数组下标当字段、把字符串拆成字符，落库即成脏行）；
 * - 必填字段缺失或类型不符 → 非法；选填字段存在但类型不符 → 非法；
 * - 数值字段必须 `typeof === 'number' && Number.isFinite`，字符串必须是 `string`；
 * - 枚举字段只校验**类型**：值域外的字符串会保留（新版本可能新增取值，见
 *   `warnUnknownEnumRemote`），只有非字符串才判非法。
 *
 * 墓碑（`deleted=true`）不走这里：墓碑只有 id 语义，没有 data。
 */
export function parseRemoteRecord(kind: Kind, data: unknown): Record<string, unknown> | null {
  if (!isPlainObject(data)) return null;
  const schema = REMOTE_SCHEMAS[kind];
  if (!schema) return null;

  for (const [field, type] of Object.entries(schema.required)) {
    if (!matchFieldType(data[field], type)) return null;
  }
  for (const [field, type] of Object.entries(schema.optional)) {
    const value = data[field];
    if (value === undefined || value === null) continue;
    if (!matchFieldType(value, type)) return null;
  }

  const enums = ENUM_FIELDS[kind];
  if (enums) {
    for (const field of Object.keys(enums)) {
      const value = data[field];
      if (value === undefined || value === null) continue;
      // 值域外不拒绝：只挡类型错（数字/对象冒充枚举）
      if (typeof value !== 'string') return null;
    }
  }

  return withinBounds(kind, data) ? data : null;
}

/**
 * 枚举字段取值不在已知值域内：**只记诊断、不拒绝整行**（M-3）。
 *
 * 为什么降级：值域外的字符串有两种来源 —— ①新版本客户端新增的分类/支付方式/调整类型
 * （合法数据，旧客户端必须认识）；②控制台手改的脏值。整行拒绝会让旧客户端**永久丢这条
 * 记录**（每次拉取都跳过、不自愈），代价远大于多一个未知标签；而入库后至少还能被本机
 * 正确版本覆盖回来（`keep-local` + 回推）。
 *
 * 边界：`num` / `bool` 的类型错误与数值越界**仍然硬拒绝**（`matchFieldType` / `withinBounds`），
 * 那类值会把报表整条算成 NaN 且不会自愈。
 */
function warnUnknownEnumRemote(
  kind: Kind,
  recordId: string,
  data: Record<string, unknown>
): void {
  const enums = ENUM_FIELDS[kind];
  if (!enums) return;
  const bad: string[] = [];
  for (const [field, allowed] of Object.entries(enums)) {
    const value = data[field];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && allowed.includes(value)) continue;
    bad.push(`${field}=${String(value)}`);
  }
  if (bad.length > 0) {
    appendWarn(`拉取到未知取值，已保留原值：${kind}:${recordId}（${bad.join(',')}）`);
  }
}

/**
 * 入站字段白名单投影（L-5）：只保留该 kind 在 `REMOTE_SCHEMAS` 里声明过的字段。
 *
 * 远端 `data` 是 jsonb、表上没有任何约束，`{ ...data }` 展开会把任意多余键写进业务表；
 * 本机之后编辑该记录时又会把这些键原样推回云端，脏字段就跨设备传播。投影后多余键在
 * 入库前即被丢弃。`id` 不在白名单里，由调用方按 `record_id` 统一补齐。
 */
function projectDeclaredFields(
  kind: Kind,
  data: Record<string, unknown>
): Record<string, unknown> {
  const schema = REMOTE_SCHEMAS[kind];
  if (!schema) return {};
  const out: Record<string, unknown> = {};
  for (const field of Object.keys(schema.required)) {
    if (field in data) out[field] = data[field];
  }
  for (const field of Object.keys(schema.optional)) {
    if (field in data) out[field] = data[field];
  }
  return out;
}

interface RemotePlan {
  /** kind → id → 待写入的值 */
  puts: Map<Kind, Map<string, unknown>>;
  /** kind → 待删除的 id */
  deletes: Map<Kind, Set<string>>;
  conflicts: SyncConflictRow[];
  unknownIds: string[];
  /** 需要把本地版本回推到云端的记录（`keep-local` / `conflict` 判定出来的） */
  repush: { kind: Kind; id: string }[];
  /** 被入站校验判非法、整行丢弃的条数（诊断用，见 L-4） */
  invalid: number;
}

/** 回推节流表：`${kind}:${id}` → 上次回推时间（模块级，进程内有效即可） */
const lastRepushAt = new Map<string, number>();

/**
 * 仅供测试使用：复位模块级可变同步状态，避免用例之间互相污染。
 *
 * 复位对象（都是「一旦置位就长期生效」的模块级状态，单测里跨用例共享同一模块实例）：
 * - `recordColumnMissing`：推送/拉取侧的「远端缺 record_updated_at 列」降级标志；
 * - `schemaColumnMissing`：推送侧的「远端缺 schema_version 列」降级标志；
 * - `lastRepushAt`：回推节流表（不清空会让下一条用例在 30s 内被判为「已回推」）。
 *
 * **生产代码路径不得调用**；命名带 `__` 前缀即表示这是测试专用入口。
 * 用法：测试的 `afterEach` 里调用一次。
 */
export function __resetSyncFlagsForTest(): void {
  recordColumnMissing = false;
  schemaColumnMissing = false;
  lastRepushAt.clear();
}

/**
 * 远端 data 与本地记录内容是否相同（远端主键在 `record_id` 里，不在 data 里）。
 * 比较口径与冲突决策共用 `canonicalJson`：两处若分叉，会一边判冲突、一边判无需回推，
 * 结果云端不收敛、冲突每轮重记（见 H2.1）。
 */
function sameContentAsRemote(cur: unknown, remote: unknown, id: string): boolean {
  if (!isPlainObject(remote)) return false;
  return canonicalJson({ ...remote, id }) === canonicalJson(cur);
}

/** 节流表只在变大时清理过期键，避免长期运行后无界增长 */
function pruneRepushThrottle(now: number): void {
  if (lastRepushAt.size < REPUSH_PRUNE_AT) return;
  for (const [key, at] of lastRepushAt) {
    if (now - at >= REPUSH_THROTTLE_MS) lastRepushAt.delete(key);
  }
}

/**
 * 把「本地较新」的记录重新入队，让云端向本地收敛（M-2）。
 *
 * 为什么需要：远端那一行已被对方用更旧的版本 upsert（最后推送者赢），而 `keep-local`
 * 原先只 `continue`，云端就永久停在旧版本；一旦换手机 / 重装从云端恢复，已作废的单会复活、
 * 补记会丢失。回推让云端追到本地版本。
 *
 * 两道约束：
 * - **节流**：同一记录 `REPUSH_THROTTLE_MS` 内最多回推一次，避免两台设备互判「本地较新」时
 *   互为对方的远端、无限对推；
 * - **best-effort**：入队失败只影响收敛速度，不能把本轮同步报成失败（否则会触发整轮重试）。
 */
async function repushLocalVersions(candidates: RemotePlan['repush']): Promise<void> {
  if (candidates.length === 0) return;
  const now = Date.now();
  const rows: { kind: Kind; recordId: string }[] = [];
  for (const c of candidates) {
    // 设备级设置永不出现在云端（put 分支也跳过），这里同样不推
    if (c.kind === 'setting' && SKIP_SETTINGS.has(c.id)) continue;
    const key = `${c.kind}:${c.id}`;
    if (now - (lastRepushAt.get(key) ?? 0) < REPUSH_THROTTLE_MS) continue;
    // 单轮上限：剩下的下一轮再推（没进这里就没有记节流，下一轮立刻可推）
    if (rows.length >= REPUSH_MAX_PER_PASS) break;
    rows.push({ kind: c.kind, recordId: c.id });
  }
  pruneRepushThrottle(now);
  if (rows.length === 0) return;
  try {
    await enqueueMany(rows);
    // 只有**入队成功**才记节流（L-3）：先记后入队的话，一次配额/事务失败会把这条记录
    // 静默冻结 30 秒，而下一轮同步本来可以立刻重试。
    for (const r of rows) lastRepushAt.set(`${r.kind}:${r.recordId}`, now);
  } catch (e) {
    console.warn('[sync] 回推本地较新版本失败，下一轮同步会重新判定', e);
  }
}

/**
 * 决策：把一页远端行算成「待写 / 待删 / 冲突」三张清单，纯内存，不落库。
 * 决策顺序与逐条应用完全一致。
 */
function planRemoteChanges(knownRows: RemoteRow[], current: Map<string, unknown>): RemotePlan {
  const plan: RemotePlan = {
    puts: new Map(),
    deletes: new Map(),
    conflicts: [],
    unknownIds: [],
    repush: [],
    invalid: 0
  };
  const { puts, deletes, conflicts: conflictRows } = plan;

  const putRow = (kind: Kind, id: string, value: unknown) => {
    let map = puts.get(kind);
    if (!map) {
      map = new Map();
      puts.set(kind, map);
    }
    map.set(id, value);
    deletes.get(kind)?.delete(id);
    current.set(`${kind}:${id}`, value);
  };

  const deleteRow = (kind: Kind, id: string) => {
    puts.get(kind)?.delete(id);
    let set = deletes.get(kind);
    if (!set) {
      set = new Set();
      deletes.set(kind, set);
    }
    set.add(id);
    current.set(`${kind}:${id}`, undefined);
  };

  /** 删单一并删明细；此刻之后出现的明细行仍会重新写入（与逐条顺序一致） */
  const dropLinesOfOrder = (orderId: string) => {
    const queuedLines = puts.get('line');
    if (queuedLines) {
      for (const [id, line] of queuedLines) {
        if ((line as SaleLine).orderId === orderId) queuedLines.delete(id);
      }
    }
    for (const [key, value] of current) {
      if (key.startsWith('line:') && value && (value as SaleLine).orderId === orderId) {
        current.set(key, undefined);
      }
    }
  };

  for (const row of knownRows) {
    if (row.deleted) {
      // 设备级设置永不同步删除：远端墓碑（旧版本 bug / 控制台误操作 / 持码者写入）
      // 删掉本机 deviceId 会让 ensureDeviceId 重新生成 UUID，正在进行中的场次立刻「找不到」，
      // getLastSession 也看不到原场次；deviceName / sync-unknown-kinds 同理只属于本机。
      if (row.kind === 'setting' && SKIP_SETTINGS.has(row.record_id)) continue;
      if (row.kind === 'order') dropLinesOfOrder(row.record_id);
      deleteRow(row.kind, row.record_id);
      continue;
    }

    const cur = current.get(`${row.kind}:${row.record_id}`);
    const decision = resolveRemote(
      row.kind,
      cur,
      row.data,
      Number(row.record_updated_at) || 0
    );

    if (decision === 'keep-local' || decision === 'conflict') {
      if (decision === 'conflict') {
        conflictRows.push({
          at: new Date().toISOString(),
          kind: row.kind,
          recordId: row.record_id,
          local: JSON.stringify(cur ?? null),
          remote: JSON.stringify(row.data ?? null)
        });
      }
      // 本地版本更权威（远端被对方用旧版本覆盖过）：重新入队让云端向本地收敛。
      // 但**只有内容真的不同才回推**：远端如果只是本机自己刚推上去的那一版（时间相同、
      // 内容相同），回推就变成无意义的写放大，还会让两台设备互相喂数据。
      // 真正入队放到事务外（见 applyRemoteBatch），这里只登记候选。
      if (!sameContentAsRemote(cur, row.data, row.record_id)) {
        plan.repush.push({ kind: row.kind, id: row.record_id });
      }
      continue;
    }

    switch (row.kind) {
      case 'session': {
        const parsedSession = parseRemoteRecord('session', row.data);
        if (!parsedSession) {
          plan.invalid += 1;
          warnInvalidRemote(row.kind, row.record_id);
          break;
        }
        warnUnknownEnumRemote('session', row.record_id, parsedSession);
        // 只保留声明过的字段：远端 data 里的多余键不能落库、更不能随下次编辑再推给别人
        const remote = projectDeclaredFields('session', parsedSession) as unknown as Session;
        const merged = cur
          ? mergeSessionPair(cur as Session, { ...remote, id: row.record_id })
          : { ...remote, id: row.record_id };
        putRow('session', row.record_id, merged);
        break;
      }
      case 'setting': {
        if (SKIP_SETTINGS.has(row.record_id)) break;
        const parsedSetting = parseRemoteRecord('setting', row.data);
        if (!parsedSetting) {
          plan.invalid += 1;
          warnInvalidRemote(row.kind, row.record_id);
          break;
        }
        // 设置只认 key/value 两个字段，其余字段一律不落库
        putRow('setting', row.record_id, { key: row.record_id, value: parsedSetting.value });
        break;
      }
      default: {
        // 未知 kind 已按 KNOWN_KINDS 过滤；这里处理 order/batch/line/adjustment/product
        const parsed = parseRemoteRecord(row.kind, row.data);
        if (!parsed) {
          // 脏行绝不能 bulkPut：一条 amountFen:"abc" 会让整场报表变 NaN，且不会自愈
          plan.invalid += 1;
          warnInvalidRemote(row.kind, row.record_id);
          break;
        }
        warnUnknownEnumRemote(row.kind, row.record_id, parsed);
        putRow(row.kind, row.record_id, {
          ...projectDeclaredFields(row.kind, parsed),
          id: row.record_id
        });
      }
    }
  }
  return plan;
}

/**
 * 按计划落库：先删（含 order 级联明细）再写；由调用方保证处在事务内。
 * 返回**真正写入/删除的业务行数**（诊断用，见 L-4；被丢弃的孤儿明细不计入）。
 */
async function applyPlannedChanges(plan: RemotePlan): Promise<number> {
  let applied = 0;
  const orderIds = [...(plan.deletes.get('order') ?? [])];
  if (orderIds.length > 0) {
    await db.orders.bulkDelete(orderIds);
    const removedLines = await db.lines.where('orderId').anyOf(orderIds).delete();
    applied += orderIds.length + removedLines;
    plan.deletes.delete('order');
  }
  for (const [kind, set] of plan.deletes) {
    if (set.size > 0) {
      await TABLE_BY_KIND[kind].bulkDelete([...set]);
      applied += set.size;
    }
  }

  // 父单已删的明细不能写回来（M-4）：order 墓碑与「更晚的 line 行」可能落在不同批次/页，
  // dropLinesOfOrder 只覆盖同一批。这里批量查一次父单存在性（不逐行 await），
  // 缺失的整条丢弃并记诊断，避免孤儿明细参与 FIFO/成本计算、再被推给其它设备。
  const linePuts = plan.puts.get('line');
  if (linePuts && linePuts.size > 0) {
    // 同一批里正在写入的 order 也算存在（首次全量时 order 与 line 常在同一个计划里）
    const createdOrders = new Set(plan.puts.get('order')?.keys() ?? []);
    const parentIds = [
      ...new Set(
        [...linePuts.values()]
          .map((line) => (line as SaleLine).orderId)
          .filter((id): id is string => Boolean(id) && !createdOrders.has(id))
      )
    ];
    const alive = new Set<string>();
    if (parentIds.length > 0) {
      const parents = await db.orders.bulkGet(parentIds);
      parentIds.forEach((id, i) => {
        if (parents[i]) alive.add(id);
      });
    }
    let dropped = 0;
    for (const [id, line] of linePuts) {
      const orderId = (line as SaleLine).orderId;
      if (createdOrders.has(orderId) || alive.has(orderId)) continue;
      linePuts.delete(id);
      dropped += 1;
    }
    if (dropped > 0) appendWarn(`丢弃 ${dropped} 条孤立明细：父单已删除`);
  }

  for (const [kind, map] of plan.puts) {
    if (map.size > 0) {
      await TABLE_BY_KIND[kind].bulkPut([...map.values()]);
      applied += map.size;
    }
  }
  if (plan.conflicts.length > 0) await saveConflicts(plan.conflicts);
  await mergeUnknownKinds(plan.unknownIds);
  return applied + plan.unknownIds.length;
}

/**
 * 冲突留痕按 `(kind, recordId)` 去重（H2.2，v5 复合索引）。
 *
 * 为什么不能 `bulkAdd`：同一条记录只要两端内容仍不同，每一轮同步都会再判一次冲突；
 * 原来每轮新增一行，设置页「待核对 N 条」只增不减，真正的冲突也被噪音淹没。
 * 这里复用已有行的自增主键原地更新 `at/local/remote`，一条记录永远只占一行。
 */
async function saveConflicts(rows: SyncConflictRow[]): Promise<void> {
  for (const row of rows) {
    const existing = await db.conflicts
      .where('[kind+recordId]')
      .equals([row.kind, row.recordId])
      .first();
    if (existing && typeof existing.id === 'number') {
      await db.conflicts.put({ ...row, id: existing.id });
    } else {
      await db.conflicts.add(row);
    }
  }
}

/** 一页应用结果（诊断口径，见 L-4） */
interface ApplyResult {
  /** 真正写入/删除的业务行数（未知 kind 记入诊断键也算已处理） */
  applied: number;
  /** 被「本地还有待推送改动」跳过的行数（不是错误，只是本轮不覆盖本地） */
  pending: number;
  /** 被入站校验判非法而跳过的行数 */
  invalid: number;
}

/**
 * 应用一页远端行：一次事务内按类型批量读、再批量写。
 * 决策（planRemoteChanges）与落库（applyPlannedChanges）分开，事务边界不变。
 *
 * `opts.replay`：本轮是「每日全量重放」的补读轮（见 `dailyReplay`）。
 * 重放会把**已经应用过的行再走一遍**，所以这一轮只跳过**冲突留痕**：
 * 同一条冲突每天重记一遍会让 `conflicts` 无界增长，真正的冲突在增量轮已经记过。
 *
 * 回推（`plan.repush`）在重放轮**照常执行**（M-1）：重放是唯一能看到「5 分钟重叠窗口之外
 * 被对方旧版本覆盖」的路径，整轮禁推会让这些记录永远停在云端旧值。量级由两道闸门控制：
 * ① 只有内容真的不同（`sameContentAsRemote`）才进候选；② `repushLocalVersions` 里的 30s 节流
 * 与单轮上限。落库本身幂等（bulkPut / delete），重复走一遍不会写坏数据。
 */
async function applyRemoteBatch(
  rows: RemoteRow[],
  opts: { replay?: boolean } = {}
): Promise<ApplyResult> {
  if (rows.length === 0) return { applied: 0, pending: 0, invalid: 0 };

  // 本地还有没推上去的改动时以本地为准
  const queued = await db.outbox.bulkGet(rows.map((r) => `${r.kind}:${r.record_id}`));
  const pendingIds = new Set<string>();
  queued.forEach((r) => {
    if (r) pendingIds.add(r.id);
  });
  const active = rows.filter((r) => !pendingIds.has(`${r.kind}:${r.record_id}`));
  const pending = rows.length - active.length;
  if (active.length === 0) return { applied: 0, pending, invalid: 0 };

  const knownRows = active.filter((r) => KNOWN_KINDS.has(r.kind));
  const unknownIds = active
    .filter((r) => !KNOWN_KINDS.has(r.kind))
    .map((r) => `${String(r.kind)}:${r.record_id}`);
  if (knownRows.length === 0 && unknownIds.length === 0) {
    return { applied: 0, pending, invalid: 0 };
  }

  const { plan, applied } = await db.transaction(
    'rw',
    [...RECORD_TABLES, db.conflicts],
    async () => {
      // 批量读当前状态，后续判断都在内存里完成
      const current = new Map<string, unknown>();
      const idsByKind = new Map<Kind, string[]>();
      for (const row of knownRows) {
        const ids = idsByKind.get(row.kind) ?? [];
        ids.push(row.record_id);
        idsByKind.set(row.kind, ids);
      }
      for (const [kind, ids] of idsByKind) {
        const locals = await TABLE_BY_KIND[kind].bulkGet(ids);
        ids.forEach((id, i) => current.set(`${kind}:${id}`, locals[i]));
      }

      const planned = planRemoteChanges(knownRows, current);
      planned.unknownIds = unknownIds;
      // 重放轮：冲突留痕不重记（同一条冲突增量轮已经记过，天天重记会让 conflicts 无界增长）
      if (opts.replay) planned.conflicts = [];
      const appliedCount = await applyPlannedChanges(planned);
      return { plan: planned, applied: appliedCount };
    }
  );

  // 回推放在事务提交之后：db.outbox 不在本事务范围内，且入队是 best-effort
  // （回推失败不能让「已经应用的远端行」被回滚，更不能让本轮同步报错）。
  await repushLocalVersions(plan.repush);
  return { applied, pending, invalid: plan.invalid };
}

/** 拉取游标：(updated_at, id) 复合水位，避免同毫秒记录在翻页时被永久跳过 */
export interface PullCursor {
  ts: number;
  id: string;
}

/**
 * 显式列（对应检视 I-001）：只取应用用得到的字段，
 * 不再把 ledger / device_id / schema_version 拉回本地。
 */
const PULL_COLUMNS = 'id,record_id,kind,data,updated_at,record_updated_at,deleted';

/**
 * 旧远端（没重跑 schema.sql，缺 record_updated_at 列）的降级列清单。
 * 推送侧本来就有缺列降级（recordColumnMissing），拉取侧必须对称，
 * 否则以前靠 select=* 能自愈的旧库会被一个 400 彻底打挂整条同步链。
 */
const PULL_COLUMNS_LEGACY = 'id,record_id,kind,data,updated_at,deleted';

/**
 * 拉取侧列缺失判断：GET 的 select 里带未知列时，PostgREST 可能返回 PGRST204
 * （schema cache 找不到列），也可能透传 Postgres 的 42703（column does not exist）。
 * 只有错误文本明确指向 record_updated_at 才降级，避免把网络错误当成缺列。
 */
function pullRecordColumnMissing(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes('record_updated_at')) return false;
  return (
    msg.includes('PGRST204') ||
    msg.includes('42703') ||
    /does not exist/i.test(msg) ||
    /schema cache/i.test(msg)
  );
}

/**
 * 构造拉取参数（纯函数，便于单测）。游标语义：
 * - `ts = 0`：首次全量，不加游标条件；
 * - `ts > 0 且 id = ''`：从旧版本升级上来的水位，用 `gte` 重放该毫秒的记录（重复应用幂等）；
 * - 否则：`(updated_at, id)` 严格大于游标。
 */
export function buildPullParams(
  cursor: PullCursor,
  ledgerKey: string,
  limit: number = PAGE_SIZE
): URLSearchParams {
  const params = new URLSearchParams({
    ledger: `eq.${ledgerKey}`,
    order: 'updated_at.asc,id.asc',
    limit: String(limit),
    select: PULL_COLUMNS
  });
  if (cursor.ts <= 0) return params;
  if (!cursor.id) {
    params.set('updated_at', `gte.${cursor.ts}`);
    return params;
  }
  params.set(
    'or',
    `(updated_at.gt.${cursor.ts},and(updated_at.eq.${cursor.ts},id.gt.${cursor.id}))`
  );
  return params;
}

/**
 * 本轮拉取的**请求起点**：把真实游标回退 `OVERLAP_MS` 吸收设备时钟偏斜（见 `OVERLAP_MS`）。
 *
 * - `ts = 0`（首次 / 清空后全量重放）原样返回，起点仍是 0，不会变成负数；
 * - id 置空：退化成 `updated_at >= 起点`，把边界那一毫秒整段重放一遍（幂等），
 *   避免复刻 `(ts,id)` 严格比较时刚好漏掉边界毫秒里 id 更小的行。
 *
 * 只用于**本轮第一页**：`buildPullParams` 与 `nextCursor` 的游标语义保持不变，
 * 持久化游标始终按真实行尾推进；否则每页都会回到同一段、永远推进不了。
 */
export function pullStartCursor(cursor: PullCursor): PullCursor {
  if (cursor.ts <= 0) return cursor;
  return { ts: Math.max(0, cursor.ts - OVERLAP_MS), id: '' };
}

/** 本页最后一条就是新游标；空页保持原游标，服务端乱序导致的回退不采纳 */
export function nextCursor(
  rows: { updated_at: number; id: string }[],
  fallback: PullCursor
): PullCursor {
  if (rows.length === 0) return fallback;
  const tail = rows[rows.length - 1];
  const ts = Number(tail.updated_at) || 0;
  const id = tail.id ?? '';
  // 时间回退，或同一毫秒内 id 比游标更小（服务端乱序）：都不采纳，否则会重复拉同一页
  if (ts < fallback.ts) return fallback;
  if (ts === fallback.ts && id < fallback.id) return fallback;
  return { ts, id };
}

/**
 * 拉取一页。旧远端缺 record_updated_at 列时，用不含该列的列清单重试一次，
 * 并复用推送侧的 recordColumnMissing 标志位做长期缓存（与推送侧策略对称）。
 */
async function fetchRemotePage(
  cfg: SyncConfig,
  cursor: PullCursor,
  limit: number = PAGE_SIZE
): Promise<RemoteRow[]> {
  const request = async (): Promise<RemoteRow[]> => {
    const params = buildPullParams(cursor, cfg.ledgerKey, limit);
    if (recordColumnMissing) params.set('select', PULL_COLUMNS_LEGACY);
    const rows = await rest<RemoteRow[]>(cfg, `yh_records?${params.toString()}`);
    return Array.isArray(rows) ? rows : [];
  };

  try {
    return await request();
  } catch (e) {
    // 已经降级过还报缺列：说明不是这一列的问题，按真实错误往上抛
    if (recordColumnMissing || !pullRecordColumnMissing(e)) throw e;
    recordColumnMissing = true;
    warnDegraded('远端缺少 record_updated_at 列，拉取已降级；升级请先执行新版 supabase/schema.sql');
    return await request();
  }
}

/**
 * 读「清空账本」标记行。返回 0 表示读不到（旧库 / 无权限 / 网络问题）：
 * 标记只是自愈兜底，读不到就按普通增量继续，绝不阻断同步，更不能阻断开单。
 */
async function readClearMark(cfg: SyncConfig): Promise<number> {
  try {
    const markerId = clearMarkerId(cfg.ledgerKey);
    const rows = await rest<{ id?: string; updated_at?: number; data?: unknown }[]>(
      cfg,
      `yh_records?id=eq.${encodeURIComponent(markerId)}&select=id,updated_at,data&limit=1`
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;
    // id 对不上说明拿到的不是标记行（旧库 select 差异等），一律当作没有标记
    if (!row || row.id !== markerId) return 0;
    return clearMarkValue(row);
  } catch {
    return 0;
  }
}

/**
 * 起始游标：先看「清空账本」标记有没有换新值。
 * 换了值就把游标重置为 0 做一次全量重放（重放幂等，代价只是多拉一轮），
 * 这样「清空」不再依赖两台设备的时钟水位：即使对方时钟偏快、
 * 或者 tombstone 与本地水位落在同一毫秒，也能完整清掉并自愈。
 *
 * H1：标记变新时**先丢弃清空前的待推送改动**（`queuedAt < clearedAt`）。
 * 清空是绝对操作：对方断网期间改过的单如果还留在发件箱，会先被 push 落云
 * （syncNow 以前是 push 先于 pull），随后清空标记触发的全量重放又把它当活行保留，
 * 「已清空」就被悄悄撤销了。这里在 push 之前丢掉这些旧改动；
 * 清空**之后**产生的新改动 `queuedAt >= clearedAt` 不受影响，照常推送（本地优先不破）。
 *
 * 这一步只在本地水位 > 0 时打探针（水位为 0 时本来就要全量拉，不需要标记），
 * 且 syncNow 会把返回值直接交给 `pull`，一轮同步只探一次。
 */
async function resolvePullStart(cfg: SyncConfig): Promise<PullCursor> {
  const local: PullCursor = { ts: lastPullAt(), id: lastPullId() };
  // 水位为 0 时本来就要全量拉取，不必多打一次探针
  if (local.ts <= 0) return local;

  const mark = await readClearMark(cfg);
  if (mark <= 0 || mark === clearedMark()) return local;

  // 先落盘再开拉：即使本轮中途失败，也不会反复重置、卡在同一份全量重放上
  setClearedMark(mark);
  const reset: PullCursor = { ts: 0, id: '' };
  setLastPullCursor(reset);

  // 先作废「清空前的旧改动」，再进入推送/重放
  const dropped = await dropOutboxQueuedBefore(mark);
  if (dropped > 0) {
    appendWarn(`清空账本：丢弃 ${dropped} 条清空前的待推送改动（它们属于被清掉的旧账本）`);
  }
  return reset;
}

/**
 * 丢弃 `queuedAt < clearedAt` 的待推送条目，返回条数。
 *
 * 边界必须严格小于：清空与改动可能落在同一毫秒，`>= clearedAt` 一律视为
 * 「清空之后的新改动」保留下来 —— 宁可多推一条，也不能把用户清空后新记的单吞掉。
 * 只删发件箱、不碰业务表：真正删除本地旧记录仍由远端墓碑（全量重放）完成，
 * 这样即使丢弃后拉取失败，本机账本也还在，不会变成「数据凭空消失」。
 */
async function dropOutboxQueuedBefore(clearedAt: number): Promise<number> {
  const stale = await db.outbox.where('queuedAt').below(clearedAt).primaryKeys();
  if (stale.length === 0) return 0;
  await db.outbox.bulkDelete(stale);
  return stale.length;
}

/** 一轮拉取循环的结果 */
interface PullPassResult {
  /** 本轮实际应用（写入/删除/记为未知类型）的远端行数 */
  pulled: number;
  /** 页数配额用光，且**确认后面还有数据**（探测页非空） */
  capped: boolean;
  /** 本轮扫到的最后一个位置：capped 时据此续扫，避免下一轮从 0 重来 */
  cursor: PullCursor;
  /** 被「本地还有待推送改动」跳过的行数（不是错误，只用于诊断） */
  skippedPending: number;
  /** 被入站校验判非法而跳过的行数 */
  skippedInvalid: number;
}

/**
 * 跑一轮拉取循环（分页 + 幂等应用）。
 *
 * - `start`：本轮起点。第一页的请求起点由 `pullStartCursor` 叠加重叠窗口，后续页跟着真实游标走；
 * - `opts.persistCursor`：是否推进持久化水位。增量轮为 true；重放轮为 false
 *   （水位由增量轮维护，重放只补数据，绝不能把 0 写回水位）；
 * - `opts.replay`：重放轮标记（不记冲突留痕，见 `applyRemoteBatch`）。
 *
 * `capped = true` 表示「页数配额用满，**并且探测页证明后面还有数据**」。
 * 只凭「第 20 页是整页」判断不够：账本恰好 `MAX_PAGES × PAGE_SIZE` 行时最后一页也是整页，
 * 会永远判 capped → 每天（实际是每轮同步）都白跑一次全量。所以满页时补一次 `limit=1`
 * 探测，只有探测有行才算 capped。
 */
async function pullOnce(
  cfg: SyncConfig,
  start: PullCursor,
  replayAll: boolean,
  opts: { persistCursor: boolean; replay: boolean }
): Promise<PullPassResult> {
  // 持久化游标：只按真实行尾推进（绝不写入回退后的起点）
  let cursor = start;
  // 请求游标：本轮第一页叠加重叠窗口，后续页从真实游标继续翻
  let requestCursor = pullStartCursor(start);
  let pulled = 0;
  let capped = false;
  let skippedPending = 0;
  let skippedInvalid = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await fetchRemotePage(cfg, requestCursor);
    if (rows.length === 0) break;

    if (replayAll) {
      const mark = rows
        .filter(isClearMarkerRow)
        .reduce((max, row) => Math.max(max, clearMarkValue(row)), 0);
      if (mark > 0 && mark !== clearedMark()) setClearedMark(mark);
    }

    // 标记行只用来对齐「清空」状态：既不写业务表，也不进未知 kind 诊断
    const dataRows = rows.filter((row) => !isClearMarkerRow(row));
    if (dataRows.length > 0) {
      const applied = await applyRemoteBatch(dataRows, { replay: opts.replay });
      pulled += applied.applied;
      skippedPending += applied.pending;
      skippedInvalid += applied.invalid;
    }
    // 先落库再推进游标：中途失败时下次仍会重放同一页，不会留下空洞
    cursor = nextCursor(rows, cursor);
    if (opts.persistCursor) setLastPullCursor(cursor);
    // 重叠窗口只用于第一页：后续页跟着真实游标走，否则会反复拉同一段
    requestCursor = cursor;
    if (rows.length < PAGE_SIZE) break;
    if (page < MAX_PAGES - 1) continue;

    // 页数配额用满且最后一页是整页：补一次 limit=1 的探测，确认后面到底还有没有数据。
    // 探测为空 → 本轮已经扫到尾，不算 capped（否则账本恰好 1 万行时永远判 capped，
    // 每轮同步都从 0 重放一遍）；探测有行 → 确实还有后续，交给调用方续扫。
    const probe = await fetchRemotePage(cfg, cursor, 1);
    capped = probe.length > 0;
  }
  return { pulled, capped, cursor, skippedPending, skippedInvalid };
}

/**
 * 「每日首次全量重放」的低频兜底轮。
 *
 * 为什么需要：`OVERLAP_MS`（5 分钟重叠窗口）只能吸收**分钟级**时钟偏斜。某台设备被手改系统时间、
 * 或 RTC 无电导致时钟偏了小时/天级时，它推上去的 `updated_at` 会落在本机水位之下很久，
 * 5 分钟窗口完全盖不住，于是本机长期漏拉且**完全静默**（没有任何报错、报表也看不出少）。
 * 所以再加一层低频兜底：每天第一次同步额外做一次从 0 开始的全量重放，把水位以下的行补回来。
 *
 * 关键取舍：
 * - **幂等**：重放是把已应用过的行再走一遍，`applyRemoteBatch` 的 bulkPut / delete 本身幂等，
 *   所以不需要额外去重；但重放轮**不回推、不记冲突**（见 `applyRemoteBatch`），
 *   否则每天都会把发件箱和 conflicts 表灌一遍；
 * - **不动水位**：重放轮 `persistCursor = false`，水位仍由增量轮按真实行尾维护；
 * - **失败不落标记**：抛错（网络 / 5xx）时不写 `lastReplay`，下次同步自动重试；
 * - **触到页数上限也不落标记**：说明可能还没扫到尾，先不认「今天补过了」，下次同步会再从 0 补一遍
 *   （重放幂等，重复扫只是多花几次请求，不会写坏数据）。本摊账本远小于
 *   `MAX_PAGES × PAGE_SIZE`（1 万行），所以正常规模下一轮就能扫完。
 */
async function dailyReplay(cfg: SyncConfig): Promise<void> {
  // 上一轮若因页数配额中断，从续扫游标接着扫；否则从 0 开始（见 LS.lastReplayCursor）
  const resume = lastReplayCursor();
  console.info(resume.ts > 0 ? '[sync] 今日全量重放（续扫）' : '[sync] 今日首次同步做全量重放');
  const pass = await pullOnce(cfg, resume.ts > 0 ? resume : { ts: 0, id: '' }, true, {
    persistCursor: false,
    replay: true
  });
  warnSkippedRows(pass.skippedPending, pass.skippedInvalid);
  if (pass.capped) {
    // 探测页证明后面还有数据：把扫到的位置落盘，下一轮从这里续扫。
    // 只「不落标记」是不够的 —— 那样下一轮又从 0 重来，第 N 万行之后永远扫不到（H-1）。
    setLastReplayCursor(pass.cursor);
    console.warn(`[sync] 全量重放未扫完（已扫至 ${pass.cursor.ts}），下次同步继续补`);
    warnReplayIncomplete(pass.cursor.ts);
    return;
  }
  clearLastReplayCursor();
  clearWarnByPrefix(WARN_REPLAY_PREFIX);
  setLastReplayDate(localDate());
  console.info(`[sync] 全量重放完成，已应用 ${pass.pulled} 行`);
}

async function pull(cfg: SyncConfig, start?: PullCursor): Promise<number> {
  // syncNow 在 push 之前已经做过清空标记检查（H1）；这里复用那次的起点，
  // 避免一轮同步为同一条标记打两次探针。
  const from = start ?? (await resolvePullStart(cfg));
  // 本轮是否从 0 全量重放（首次 / 清空账本后）：全量时看到标记行即可直接对齐，不必多打探针
  const replayAll = from.ts <= 0;

  // 增量轮：起点叠加重叠窗口，持久化水位按真实行尾推进
  const incremental = await pullOnce(cfg, from, replayAll, {
    persistCursor: true,
    replay: false
  });
  const pulled = incremental.pulled;
  warnSkippedRows(incremental.skippedPending, incremental.skippedInvalid);

  if (lastReplayDate() === localDate()) return pulled;

  // 水位本来就是 0：增量轮已经是一次完整全量，不必再叠一层，补落标记即可
  if (replayAll) {
    // 被页数配额截断时记下续扫点：下一轮的每日重放从那里接着扫，而不是再从 0 开始
    if (incremental.capped) setLastReplayCursor(incremental.cursor);
    else {
      clearLastReplayCursor();
      setLastReplayDate(localDate());
    }
    return pulled;
  }

  await dailyReplay(cfg);
  return pulled;
}

/* ------------------------------------------------- 冲突查看与「用云端」 */

/** 设置页「同步冲突」列表的一条（已格式化，UI 只管渲染） */
export interface ConflictView {
  id: number;
  at: string;
  kind: string;
  recordId: string;
  /** 单号/商品名等一眼能认出的标题 */
  title: string;
  /** 本地值摘要（金额、支付方式、时间等关键字段） */
  localText: string;
  /** 云端值摘要 */
  remoteText: string;
}

const CONFLICT_KIND_LABEL: Record<string, string> = {
  order: '订单',
  line: '明细',
  product: '商品',
  batch: '进货',
  adjustment: '库存调整',
  session: '场次',
  setting: '设置'
};

const PAY_LABEL: Record<string, string> = {
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝'
};

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function pickStr(obj: unknown, key: string): string | null {
  if (!isPlainObject(obj)) return null;
  const v = obj[key];
  return typeof v === 'string' && v ? v : null;
}

function pickNum(obj: unknown, key: string): number | null {
  if (!isPlainObject(obj)) return null;
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 列表标题：订单用时间、商品用名称，其余退回 `类型 id` */
function conflictTitle(kind: string, recordId: string, local: unknown, remote: unknown): string {
  const label = CONFLICT_KIND_LABEL[kind] ?? kind;
  if (kind === 'order') {
    const at = pickStr(local, 'createdAt') ?? pickStr(remote, 'createdAt');
    if (at) return `${label} ${isoToLocalDate(at)} ${isoToTime(at)}`;
  }
  if (kind === 'product') {
    const name = pickStr(local, 'name') ?? pickStr(remote, 'name');
    if (name) return `${label} ${name}`;
  }
  return `${label} ${recordId}`;
}

/** 本地值 / 云端值的摘要：只展示会被摊主感知的字段 */
function conflictValueText(kind: string, raw: unknown): string {
  if (!isPlainObject(raw)) return '（空）';
  const parts: string[] = [];
  switch (kind) {
    case 'order': {
      const total = pickNum(raw, 'totalFen');
      if (total !== null) parts.push(`¥${fenToStr(total)}`);
      const pay = pickStr(raw, 'payMethod');
      if (pay) parts.push(PAY_LABEL[pay] ?? pay);
      if (raw.voided === true) parts.push('已作废');
      const at = pickStr(raw, 'createdAt') ?? pickStr(raw, 'updatedAt');
      if (at) parts.push(`${isoToLocalDate(at)} ${isoToTime(at)}`);
      break;
    }
    case 'product': {
      const name = pickStr(raw, 'name');
      if (name) parts.push(name);
      const price = pickNum(raw, 'priceList');
      if (price !== null) parts.push(`标价 ¥${fenToStr(price)}`);
      const unit = pickStr(raw, 'unitBase');
      if (unit) parts.push(`单位 ${unit}`);
      break;
    }
    case 'line': {
      const qty = pickNum(raw, 'qtyBase');
      if (qty !== null) parts.push(`数量 ${qty}`);
      const amount = pickNum(raw, 'amountFen');
      if (amount !== null) parts.push(`¥${fenToStr(amount)}`);
      break;
    }
    default: {
      const text = JSON.stringify(raw);
      return text.length > 80 ? `${text.slice(0, 77)}…` : text;
    }
  }
  return parts.length > 0 ? parts.join(' · ') : '（无关键字段）';
}

/**
 * 读取冲突列表（设置页「查看」用）。
 * 只读 `conflicts` 表，不触发任何网络请求；按时间倒序，最新的冲突排在最上面。
 */
export async function loadConflicts(): Promise<ConflictView[]> {
  const rows = await db.conflicts.orderBy('at').reverse().toArray();
  return rows.map((row) => {
    const local = safeParse(row.local);
    const remote = safeParse(row.remote);
    return {
      id: row.id ?? 0,
      at: row.at,
      kind: row.kind,
      recordId: row.recordId,
      title: conflictTitle(row.kind, row.recordId, local, remote),
      localText: conflictValueText(row.kind, local),
      remoteText: conflictValueText(row.kind, remote)
    };
  });
}

/**
 * 采用云端版本（设置页「用云端」）：把冲突行里的 `remote` 快照写回本地，然后删掉这条冲突。
 *
 * 为什么直接写库而不是复用 pull：冲突行已经保存了完整的远端快照，单条重放要重造
 * 分页/游标/校验一整套上下文；这里走与入站落库**同一套**校验（parseRemoteRecord）
 * 和字段投影，既简单又不会把脏字段写进业务表。
 *
 * 不额外入队：写进去的就是云端现有版本，本地与云端已经一致；再推一次只会多一轮写放大。
 * 写入放在事务里，冲突删除与业务写入同生共死 —— 中途失败时冲突行仍在，用户可以重试。
 */
export async function adoptRemoteConflict(id: number): Promise<void> {
  const row = await db.conflicts.get(id);
  if (!row) return;
  if (!KNOWN_KINDS.has(row.kind as Kind)) throw new Error(`未知记录类型：${row.kind}`);
  const kind = row.kind as Kind;

  const remote = safeParse(row.remote);
  if (!isPlainObject(remote)) throw new Error('云端快照是空的，没有采用');
  const parsed = parseRemoteRecord(kind, remote);
  if (!parsed) throw new Error('云端快照没通过校验，没有采用');

  await db.transaction('rw', [TABLE_BY_KIND[kind], db.conflicts], async () => {
    if (kind === 'setting') {
      const value = parsed.value;
      if (typeof value !== 'string') throw new Error('云端设置值不合法，没有采用');
      await db.settings.put({ key: row.recordId, value });
    } else if (kind === 'session') {
      // 场次沿用既有合并口径：采用云端不等于无条件覆盖本机补记
      const remoteSession = projectDeclaredFields('session', parsed) as unknown as Session;
      const cur = await db.sessions.get(row.recordId);
      const merged = cur
        ? mergeSessionPair(cur, { ...remoteSession, id: row.recordId })
        : { ...remoteSession, id: row.recordId };
      await db.sessions.put(merged);
    } else {
      await TABLE_BY_KIND[kind].put({
        ...projectDeclaredFields(kind, parsed),
        id: row.recordId
      });
    }
    await db.conflicts.delete(id);
  });
}

/* ------------------------------------------------------------------ 对外 */

export interface SyncResult {
  pushed: number;
  pulled: number;
}

export async function syncNow(cfg: SyncConfig): Promise<SyncResult> {
  if (!navigator.onLine) throw new Error('当前离线');
  const deviceId = (await db.settings.get('deviceId'))?.value ?? '';
  // H1：清空标记检查必须在 push 之前。否则本机（B）断网期间的旧改动会先落云，
  // 清空标记触发的全量重放随后又把这些「复活」的行当成正常数据保留下来。
  // resolvePullStart 在标记变新时会丢弃 `queuedAt < clearedAt` 的发件箱条目；
  // 清空之后的新改动不受影响，会在下面的 pushOutbox 里正常补发。
  const start = await resolvePullStart(cfg);
  const pushed = await pushOutbox(cfg, deviceId);
  const pulled = await pull(cfg, start);
  localStorage.setItem(LS.lastSync, String(Date.now()));
  localStorage.removeItem(LS.error);
  return { pushed, pulled };
}

export async function testSyncConfig(cfg: SyncConfig): Promise<void> {
  await rest(cfg, 'yh_records?select=id&limit=1');
}

/**
 * 清空云端账本（危险操作，与本地清空一起用）。
 * v2 起服务端撤销了 anon 的 DELETE，这里改为软删除：把本账本所有行标记 deleted=true。
 * 好处：误操作后可在控制台把 deleted 改回 false 恢复；且不再存在「一键物理抹除」的能力。
 *
 * 软删除后「清空」退化成一条靠 updated_at 水位传播的普通变更，而 pull 只拉
 * 严格大于本地水位的行：另一台设备时钟偏快（水位高于 tombstone 的 updated_at），
 * 或 tombstone 恰好落在对方水位的同一毫秒，都会永远拉不到、且不会自愈。
 * 所以清空后再写一条固定 id 的标记行，标记值一变，对方就把游标重置为 0 全量重放一次。
 */
export async function clearCloud(cfg: SyncConfig): Promise<void> {
  const clearedAt = Date.now();
  await rest(cfg, `yh_records?ledger=eq.${encodeURIComponent(cfg.ledgerKey)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ deleted: true, updated_at: clearedAt })
  });

  // 标记行不属于任何业务表（pull 侧会整行过滤掉），只用于通知其它设备重放；
  // id 带账本码，避免多个账本共用一张表时互相覆盖同一条标记。
  // 不写 record_updated_at / schema_version，让旧库靠列默认值也能写入。
  const markerId = clearMarkerId(cfg.ledgerKey);
  await rest(cfg, 'yh_records?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([
      {
        id: markerId,
        record_id: markerId,
        ledger: cfg.ledgerKey,
        kind: CLEAR_MARKER_KIND,
        data: { clearedAt },
        updated_at: clearedAt,
        deleted: false
      }
    ])
  });
}

export async function syncPending(): Promise<number> {
  return pendingCount();
}

export async function markAllDirty(): Promise<void> {
  await enqueueAllLocal();
  syncWanted();
}

/** 合并/导入之后，把本地整库标记为待推送 */
export async function afterMerge(): Promise<void> {
  await markAllDirty();
}

/** 给设置页展示的本地概况 */
export async function localSummary(): Promise<{ products: number; orders: number; pending: number }> {
  const all = await loadAll();
  return {
    products: all.products.length,
    orders: all.orders.length,
    pending: await pendingCount()
  };
}