// 云同步：本地优先 + 发件箱推送 + 增量拉取。
// 后端：Supabase（PostgREST）。配置只存 localStorage，不写进会被同步的设置表。

import { db } from './db';
import { loadAll } from './repo';
import { enqueueAllLocal, pendingCount, syncWanted } from './outbox';
import { DEFAULT_SYNC } from './syncDefaults';
import { mergeSessionPair } from './sessionLogic';
import { businessTime, resolveRemote } from './syncResolve';
import type { SyncConflictRow } from './db';
import type { Table } from 'dexie';
import type { SaleLine, Session, Setting } from './types';

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
  lastSync: 'yh-sync-last-sync',
  error: 'yh-sync-error',
  disabled: 'yh-sync-disabled'
};

/** 设备身份类设置不参与云同步 */
const SKIP_SETTINGS = new Set<string>(['deviceId', 'deviceName']);

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
/** 未知 kind 最多保留的 id 数（只表示条数，不表方向） */
const UNKNOWN_KIND_KEEP = 20;

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

function setLastPull(v: number): void {
  localStorage.setItem(LS.lastPull, String(v));
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
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    ...init,
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
  /** 业务修改时间（毫秒）；远端没加列时缺省 */
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

type OutboxRow = (typeof db.outbox) extends Table<infer T> ? T : never;

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

      try {
        localStorage.setItem(
          'yh-sync-warn',
          '远端缺少 record_updated_at 或 schema_version 列，已降级推送'
        );
      } catch {
        /* 隐私模式忽略 */
      }
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
const UNKNOWN_KINDS_KEY = 'sync-unknown-kinds';

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

interface RemotePlan {
  /** kind → id → 待写入的值 */
  puts: Map<Kind, Map<string, unknown>>;
  /** kind → 待删除的 id */
  deletes: Map<Kind, Set<string>>;
  conflicts: SyncConflictRow[];
  unknownIds: string[];
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
    unknownIds: []
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

    if (decision === 'keep-local') continue;
    if (decision === 'conflict') {
      conflictRows.push({
        at: new Date().toISOString(),
        kind: row.kind,
        recordId: row.record_id,
        local: JSON.stringify(cur ?? null),
        remote: JSON.stringify(row.data ?? null)
      });
      continue;
    }

    switch (row.kind) {
      case 'session': {
        const remote = row.data as Session;
        const merged = cur
          ? mergeSessionPair(cur as Session, { ...remote, id: row.record_id })
          : { ...remote, id: row.record_id };
        putRow('session', row.record_id, merged);
        break;
      }
      case 'setting': {
        if (SKIP_SETTINGS.has(row.record_id)) break;
        const remote = row.data as Setting;
        if (remote && typeof remote.key === 'string') {
          putRow('setting', row.record_id, { key: row.record_id, value: remote.value });
        }
        break;
      }
      default:
        // 未知 kind 已按 KNOWN_KINDS 过滤；这里处理 order/batch/line/adjustment/product
        putRow(row.kind, row.record_id, {
          ...(row.data as Record<string, unknown>),
          id: row.record_id
        });
    }
  }
  return plan;
}

/** 按计划落库：先删（含 order 级联明细）再写；由调用方保证处在事务内 */
async function applyPlannedChanges(plan: RemotePlan): Promise<void> {
  const orderIds = [...(plan.deletes.get('order') ?? [])];
  if (orderIds.length > 0) {
    await db.orders.bulkDelete(orderIds);
    await db.lines.where('orderId').anyOf(orderIds).delete();
    plan.deletes.delete('order');
  }
  for (const [kind, set] of plan.deletes) {
    if (set.size > 0) await TABLE_BY_KIND[kind].bulkDelete([...set]);
  }
  for (const [kind, map] of plan.puts) {
    if (map.size > 0) await TABLE_BY_KIND[kind].bulkPut([...map.values()]);
  }
  if (plan.conflicts.length > 0) await db.conflicts.bulkAdd(plan.conflicts);
  await mergeUnknownKinds(plan.unknownIds);
}

/**
 * 应用一页远端行：一次事务内按类型批量读、再批量写。
 * 决策（planRemoteChanges）与落库（applyPlannedChanges）分开，事务边界不变。
 */
async function applyRemoteBatch(rows: RemoteRow[]): Promise<void> {
  if (rows.length === 0) return;

  // 本地还有没推上去的改动时以本地为准
  const queued = await db.outbox.bulkGet(rows.map((r) => `${r.kind}:${r.record_id}`));
  const pending = new Set<string>();
  queued.forEach((r) => {
    if (r) pending.add(r.id);
  });
  const active = rows.filter((r) => !pending.has(`${r.kind}:${r.record_id}`));
  if (active.length === 0) return;

  const knownRows = active.filter((r) => KNOWN_KINDS.has(r.kind));
  const unknownIds = active
    .filter((r) => !KNOWN_KINDS.has(r.kind))
    .map((r) => `${String(r.kind)}:${r.record_id}`);
  if (knownRows.length === 0 && unknownIds.length === 0) return;

  await db.transaction('rw', [...RECORD_TABLES, db.conflicts], async () => {
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

    const plan = planRemoteChanges(knownRows, current);
    plan.unknownIds = unknownIds;
    await applyPlannedChanges(plan);
  });
}

async function pull(cfg: SyncConfig): Promise<number> {
  let since = lastPullAt();
  let pulled = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      ledger: `eq.${cfg.ledgerKey}`,
      updated_at: `gt.${since}`,
      order: 'updated_at.asc',
      limit: String(PAGE_SIZE),
      select: '*'
    });
    const rows = await rest<RemoteRow[]>(cfg, `yh_records?${params.toString()}`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    await applyRemoteBatch(rows);
    for (const row of rows) {
      since = Math.max(since, Number(row.updated_at) || 0);
      pulled++;
    }
    setLastPull(since);
    if (rows.length < PAGE_SIZE) break;
  }
  return pulled;
}

/* ------------------------------------------------------------------ 对外 */

export interface SyncResult {
  pushed: number;
  pulled: number;
}

export async function syncNow(cfg: SyncConfig): Promise<SyncResult> {
  if (!navigator.onLine) throw new Error('当前离线');
  const deviceId = (await db.settings.get('deviceId'))?.value ?? '';
  const pushed = await pushOutbox(cfg, deviceId);
  const pulled = await pull(cfg);
  localStorage.setItem(LS.lastSync, String(Date.now()));
  localStorage.removeItem(LS.error);
  return { pushed, pulled };
}

export async function testSyncConfig(cfg: SyncConfig): Promise<void> {
  await rest(cfg, 'yh_records?select=id&limit=1');
}

/** 清空云端账本（危险操作，与本地清空一起用） */
export async function clearCloud(cfg: SyncConfig): Promise<void> {
  await rest(cfg, `yh_records?ledger=eq.${encodeURIComponent(cfg.ledgerKey)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' }
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