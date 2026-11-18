import type { Table } from 'dexie';
import { db } from './db';
import { canonicalJson } from './canonical';
import { SKIP_SETTINGS, enqueueInTx } from './outbox';
import { assertLeaseCurrent, pauseSync, readSyncControl, resumeSync, runMaintenance } from './syncControl';
import { protocolScope, readProtocol, storeProtocol, type SyncProtocol } from './syncProtocol';
import type { SyncConfig } from './syncTypes';
import type { SyncKind, OutboxItem } from './outbox';
import type { ReconnectProjectionRow } from './syncReconcile';

export type ReconnectParser = (kind: SyncKind, data: unknown) => Record<string, unknown> | null;
export type ReconnectChoice = 'local' | 'remote';
export type ReconnectStatus = 'localOnly' | 'remoteOnly' | 'different' | 'same';
export interface ReconnectGroup {
  recordKey: string;
  status: ReconnectStatus;
  localCount: number;
  remoteCount: number;
  label: string;
  localText: string;
  remoteText: string;
}
export type ReconnectCounts = Record<ReconnectStatus, number>;
export interface ReconnectPreview {
  token: string;
  generation: number;
  scope: string;
  localFingerprint: string;
  remoteFingerprint: string;
  counts: ReconnectCounts;
  groups: ReconnectGroup[];
}
type Item = { kind: SyncKind; id: string; data: Record<string, unknown> | null; stamp: number };
type Snapshot = { items: Map<string, Item>; serial: string; maxTime: number; expectedRows?: ReconnectProjectionRow[] };
type Group = ReconnectGroup & { local: Item[]; remote: Item[] };
type Memory = { cfg: SyncConfig; parse: ReconnectParser; local: Snapshot; remote: Snapshot;
  protocol: SyncProtocol; preview: ReconnectPreview; groups: Group[]; confirming: boolean };
interface Meta { key: string; kind: string; scope: string; [field: string]: unknown }
const memory = new Map<string, Memory>();
const kinds: SyncKind[] = ['product', 'batch', 'order', 'line', 'adjustment', 'session', 'setting'];
const tables: Record<SyncKind, Table<Record<string, unknown>, string>> = {
  product: db.products, batch: db.batches, order: db.orders, line: db.lines,
  adjustment: db.adjustments, session: db.sessions, setting: db.settings
} as unknown as Record<SyncKind, Table<Record<string, unknown>, string>>;
const businessTables = Object.values(tables);
const meta = db.table<Meta, string>('syncMeta');
const PAGE_SIZE = 500;
export class ReconnectError extends Error {
  readonly code: 'RECONNECT_STALE' | 'RECONNECT_INVALID';
  constructor(message: string) {
    super(`Reconnect: ${message}`);
    this.name = 'ReconnectError';
    this.code = /changed|stale|snapshot/.test(message) ? 'RECONNECT_STALE' : 'RECONNECT_INVALID';
  }
}
function fail(message: string): never { throw new ReconnectError(message); }
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function dates(value: unknown): number {
  if (!object(value)) return 0;
  return Object.entries(value).reduce((max, [key, val]) => {
    const time = typeof val === 'string' && /(At|Date)$/.test(key) ? Date.parse(val) : NaN;
    return Math.max(max, Number.isFinite(time) ? time : 0, object(val) ? dates(val) : 0);
  }, 0);
}
function snapshot(items: Map<string, Item>, extras?: unknown): Snapshot {
  const sorted = [...items].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { items, serial: canonicalJson([sorted, extras]),
    maxTime: sorted.reduce((max, [, item]) => Math.max(max, item.stamp, dates(item.data)), 0) };
}
async function fingerprint(serial: string): Promise<string> {
  const bytes = new TextEncoder().encode(serial);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function localSnapshot(parse: ReconnectParser): Promise<Snapshot> {
  const items = new Map<string, Item>();
  for (const kind of kinds) {
    for (const raw of await tables[kind].toArray()) {
      const id = raw[kind === 'setting' ? 'key' : 'id'];
      if (typeof id !== 'string' || !id) fail('invalid local identity');
      if (kind === 'setting' && SKIP_SETTINGS.has(id)) continue;
      const data = parse(kind, raw);
      if (!data) fail(`invalid local record ${kind}:${id}`);
      items.set(`${kind}:${id}`, { kind, id, data: { ...data }, stamp: 0 });
    }
  }
  // Queue mutations (including a deletion with no surviving local row) invalidate a preview too.
  return snapshot(items, (await db.outbox.toArray()).sort((a, b) => a.id.localeCompare(b.id)));
}
async function readLocal(parse: ReconnectParser): Promise<Snapshot> {
  return db.transaction('r', [...businessTables, db.outbox], () => localSnapshot(parse));
}
async function remoteSnapshot(cfg: SyncConfig, parse: ReconnectParser): Promise<Snapshot> {
  const base = JSON.parse(protocolScope(cfg)) as [string, string];
  const items = new Map<string, Item>();
  const versions: ReconnectProjectionRow[] = [];
  const project = (row: Record<string, unknown>): ReconnectProjectionRow => ({ id: row.id as string,
    record_id: row.record_id as string, kind: row.kind as string, data: row.data,
    updated_at: Number(row.updated_at), record_updated_at: Number(row.record_updated_at) || 0,
    deleted: row.deleted as boolean });
  let cursor: { ts: number; id: string } | undefined;
  let legacy = false;
  for (let page = 0; page < 2000; page++) {
    const params = new URLSearchParams({ ledger: `eq.${base[1]}`, order: 'updated_at.asc,id.asc',
      limit: String(PAGE_SIZE), select: `id,record_id,kind,data,updated_at,${legacy ? '' : 'record_updated_at,'}deleted` });
    if (cursor) params.set('or', `(updated_at.gt.${cursor.ts},and(updated_at.eq.${cursor.ts},id.gt.${cursor.id}))`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    let raw: unknown;
    try {
      response = await fetch(`${base[0]}/rest/v1/yh_records?${params}`, { method: 'GET',
        headers: { apikey: cfg.anonKey.trim(), 'x-ledger-key': base[1], Accept: 'application/json',
          ...(cfg.anonKey.trim().startsWith('eyJ') ? { Authorization: `Bearer ${cfg.anonKey.trim()}` } : {}) },
        signal: controller.signal });
      raw = await response.json();
    } finally { clearTimeout(timeout); }
    if (!response.ok) {
      const error = canonicalJson(raw);
      if (!legacy && /record_updated_at/.test(error) && /PGRST204|42703/.test(error)) {
        legacy = true; page--; continue;
      }
      fail(`remote read failed (HTTP ${response.status})`);
    }
    if (!Array.isArray(raw)) fail('invalid remote page');
    if (raw.length > PAGE_SIZE) fail('invalid remote page size');
    for (const row of raw) {
      if (!object(row) || typeof row.id !== 'string' || !row.id ||
        !Number.isSafeInteger(row.updated_at) || Number(row.updated_at) < 0) fail('invalid remote cursor');
      const next = { ts: Number(row.updated_at), id: row.id };
      if (cursor && (next.ts < cursor.ts || (next.ts === cursor.ts && next.id <= cursor.id)))
        fail('remote cursor did not advance');
      cursor = next;
      // Ledger clear markers carry no business row, but remain part of the fingerprint below.
      if (row.kind === 'ledger' && row.id === `__ledger_cleared__:${base[1]}`) {
        if (!object(row.data) || typeof row.record_id !== 'string' || typeof row.deleted !== 'boolean') fail('invalid clear marker');
        versions.push(project(row));
        continue;
      }
      if (!kinds.includes(row.kind as SyncKind) || typeof row.record_id !== 'string' || !row.record_id ||
        row.id !== `${row.kind}:${row.record_id}` || typeof row.deleted !== 'boolean' ||
        (row.ledger !== undefined && row.ledger !== base[1]) ||
        (row.record_updated_at !== undefined && (!Number.isSafeInteger(row.record_updated_at) || Number(row.record_updated_at) < 0)))
        fail('invalid remote record');
      const kind = row.kind as SyncKind;
      const id = row.record_id;
      if (items.has(row.id)) fail('duplicate remote record');
      if (kind === 'setting' && SKIP_SETTINGS.has(id)) continue;
      versions.push(project(row));
      const parsed = row.deleted ? null : parse(kind, row.data);
      if (!row.deleted && !parsed) fail(`invalid remote data ${row.id}`);
      const identity = kind === 'setting' ? 'key' : 'id';
      if (parsed && parsed[identity] !== undefined && parsed[identity] !== id) fail('remote identity mismatch');
      items.set(row.id, { kind, id, data: parsed ? { ...parsed, [identity]: id } : null,
        stamp: Math.max(Number(row.updated_at), Number(row.record_updated_at) || 0) });
    }
    if (raw.length < PAGE_SIZE) {
      versions.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      return { ...snapshot(items, versions), expectedRows: versions };
    }
  }
  return fail('remote snapshot exceeds safe page limit');
}
function describe(rows: Item[]): string {
  if (!rows.length) return '本端没有此记录';
  const item = rows.find((row) => row.kind === 'order') ?? rows[0];
  const data = item.data;
  if (!data) return '已删除（远端墓碑）';
  const money = (value: unknown) => `¥${(Number(value) / 100).toFixed(2)}`;
  switch (item.kind) {
    case 'order': return `${String(data.createdAt ?? '').slice(0, 16).replace('T', ' ')} · ${money(data.totalFen)} · ${rows.filter((row) => row.kind === 'line' && row.data).length} 条明细`;
    case 'product': return `${String(data.name)} · ${money(data.priceList)}/${String(data.unitBase)}`;
    case 'batch': return `${String(data.receivedAt)} · ${String(data.qtyBase)} 个 · 成本 ${money(data.unitCostFen)}`;
    case 'session': return `${String(data.startedAt).slice(0, 16).replace('T', ' ')} · ${data.status === 'closed' ? '已结账' : '进行中'}`;
    case 'setting': return String(data.value);
    case 'adjustment': return `${String(data.createdAt).slice(0, 10)} · 调整 ${String(data.qtyBase)} 个 · ${String(data.reason ?? '')}`;
    default: return '已删除的明细';
  }
}
function groupSnapshots(local: Snapshot, remote: Snapshot): Group[] {
  const grouped = new Map<string, { local: Item[]; remote: Item[] }>();
  for (const side of ['local', 'remote'] as const) {
    const own = side === 'local' ? local.items : remote.items;
    const other = side === 'local' ? remote.items : local.items;
    for (const [key, item] of own) {
      let groupKey = key;
      if (item.kind === 'line') {
        const parent = item.data?.orderId ?? other.get(key)?.data?.orderId;
        const otherParent = other.get(key)?.data?.orderId;
        if (item.data && otherParent && item.data.orderId !== otherParent) fail('line shared across order groups');
        if (parent !== undefined && (typeof parent !== 'string' || !parent)) fail('invalid line parent');
        if (parent) groupKey = `order:${parent}`;
        else if (item.data) fail('missing line parent');
      }
      const group = grouped.get(groupKey) ?? { local: [], remote: [] };
      group[side].push(item);
      grouped.set(groupKey, group);
    }
  }
  const meaningful = (rows: Item[]) => rows.filter((item) => item.kind !== 'line' || item.data);
  const content = (rows: Item[]) => canonicalJson(meaningful(rows).map(({ kind, id, data }) => ({ kind, id, data })));
  return [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([recordKey, group]) => {
    for (const rows of [group.local, group.remote]) {
      rows.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
      if (!recordKey.startsWith('order:') || rows.length === 0) continue;
      const order = rows.find((item) => item.kind === 'order');
      if (!order) fail(`missing order header ${recordKey}`);
      if (!order.data) continue;
      const lines = rows.filter((item) => item.kind === 'line' && item.data);
      const ids = order.data.lineIds;
      if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id) ||
        new Set(ids).size !== ids.length || canonicalJson([...ids].sort()) !== canonicalJson(lines.map((line) => line.id).sort())))
        fail(`incomplete order lines ${recordKey}`);
      if (lines.reduce((sum, line) => sum + Number(line.data!.amountFen), 0) !== order.data.totalFen)
        fail(`incomplete order total ${recordKey}`);
    }
    const left = meaningful(group.local);
    const right = meaningful(group.remote);
    const status: ReconnectStatus = left.length === 0 ? (right.some((item) => item.data) ? 'remoteOnly' : 'same') :
      right.length === 0 ? 'localOnly' : content(left) === content(right) ? 'same' : 'different';
    const first = [...left, ...right].find((item) => item.kind !== 'line');
    const names: Partial<Record<SyncKind, string>> = { order: '订单', product: '商品', batch: '进货批次',
      session: '场次', adjustment: '库存调整', setting: '设置' };
    const label = `${names[first?.kind ?? 'line'] ?? '明细'}${first?.data?.name ? ` · ${String(first.data.name)}` : ''}`;
    return { recordKey, status, localCount: left.length, remoteCount: right.length,
      label, localText: describe(left), remoteText: describe(right), ...group };
  });
}
function counts(groups: Group[]): ReconnectCounts {
  return groups.reduce((sum, group) => { sum[group.status]++; return sum; },
    { localOnly: 0, remoteOnly: 0, different: 0, same: 0 });
}
/** Pauses persistently, then reads only; the token and all record snapshots remain in this module's memory. */
export async function prepareReconnect(cfg: SyncConfig, parser?: ReconnectParser): Promise<ReconnectPreview> {
  const scope = protocolScope(cfg);
  const config = { ...cfg };
  memory.clear();
  const control = await readSyncControl();
  const paused = control.paused && !control.maintenance ? control : await pauseSync('Reconnect confirmation required');
  const parse = parser ?? (await import('./sync')).parseRemoteRecord;
  const protocol = await readProtocol(config);
  if (!protocol.ledgerScoped) {
    const binding = await meta.get('sync-binding');
    const stored = binding ? null : (await import('./sync')).getStoredSyncConfig();
    const previousScope = binding?.scope ?? (stored ? protocolScope(stored) : null);
    if (previousScope && previousScope !== scope) fail('ledger scope change requires ledger-scoped sync protocol');
  }
  const remote = await remoteSnapshot(config, parse);
  const local = await readLocal(parse);
  const groups = groupSnapshots(local, remote);
  const preview: ReconnectPreview = { token: crypto.randomUUID(), generation: paused.generation, scope,
    localFingerprint: await fingerprint(local.serial), remoteFingerprint: await fingerprint(remote.serial),
    counts: counts(groups), groups: groups.map(({ recordKey, status, localCount, remoteCount, label, localText, remoteText }) =>
      ({ recordKey, status, localCount, remoteCount, label, localText, remoteText })) };
  await db.transaction('rw', db.syncMeta, async () => {
    const current = await readSyncControl();
    if (!current.paused || current.maintenance || current.generation !== paused.generation) fail('pause changed; preview stale');
    await meta.put({ key: `reconnect-recovery:${scope}`, kind: 'reconnect-recovery', scope,
      generation: preview.generation, localFingerprint: preview.localFingerprint,
      remoteFingerprint: preview.remoteFingerprint, counts: preview.counts });
  });
  memory.clear();
  memory.set(preview.token, { cfg: config, parse, local, remote, protocol, preview: structuredClone(preview), groups, confirming: false });
  return preview;
}
/** Only writes the confirmed union locally; cfg storage must succeed before generation-CAS resume. */
export async function confirmReconnect(preview: ReconnectPreview,
  choices: Record<string, ReconnectChoice>): Promise<{ generation: number }> {
  const saved = memory.get(preview.token);
  if (!saved || canonicalJson(saved.preview) !== canonicalJson(preview)) fail('preview token is stale');
  if (saved.confirming) fail('confirmation already running');
  const required = new Set(saved.groups.filter((group) => group.status === 'different').map((group) => group.recordKey));
  if (!object(choices) || [...required].some((key) => choices[key] !== 'local' && choices[key] !== 'remote') ||
    Object.keys(choices).some((key) => !required.has(key))) fail('every conflict requires a local/remote choice');
  choices = { ...choices };
  preview = saved.preview;
  saved.confirming = true;
  try {
    const current = await readSyncControl();
    if (!current.paused || current.maintenance || current.generation !== preview.generation) fail('generation changed; snapshot stale');
    const protocol = await readProtocol(saved.cfg);
    const remote = await remoteSnapshot(saved.cfg, saved.parse);
    const local = await readLocal(saved.parse);
    if (remote.serial !== saved.remote.serial || local.serial !== saved.local.serial ||
      canonicalJson(protocol) !== canonicalJson(saved.protocol)) fail('snapshot changed; prepare again');
    const generation = await runMaintenance('Reconnect confirmation', async (lease) => {
      if (lease.generation !== preview.generation + 1) fail('generation changed; snapshot stale');
      return db.transaction('rw', [...businessTables, db.outbox, db.syncMeta, db.conflicts,
        db.remotePendingLines, db.remoteOrderUndo], async () => {
        await assertLeaseCurrent(lease);
        if ((await localSnapshot(saved.parse)).serial !== saved.local.serial) fail('local snapshot changed');
        const timestamp = new Date(Math.max(Date.now(), local.maxTime, remote.maxTime) + 1).toISOString();
        await meta.put({ key: 'sync-binding', kind: 'binding', scope: preview.scope, clearEpoch: protocol.clearEpoch });
        await db.outbox.clear();
        const queue: OutboxItem[] = [];
        for (const group of saved.groups) {
          const choice = group.status === 'localOnly' ? 'local' : group.status === 'remoteOnly' ? 'remote' : choices[group.recordKey];
          if (!choice) continue;
          const selected = group[choice];
          const selectedLive = selected.filter((item) => item.data && !(group.recordKey.startsWith('order:') &&
            selected.some((row) => row.kind === 'order' && !row.data)));
          for (const item of group.local) {
            if (!selectedLive.some((row) => row.kind === item.kind && row.id === item.id)) await tables[item.kind].delete(item.id);
          }
          for (const item of selectedLive) {
            await tables[item.kind].put({ ...item.data!, ...(choice === 'local' ? { updatedAt: timestamp } : {}) });
            if (choice === 'local') queue.push({ kind: item.kind, recordId: item.id });
          }
          // A chosen order is a complete group: remove only that order's remote-extra live lines.
          if (choice === 'local' && group.status === 'different' && group.recordKey.startsWith('order:')) {
            for (const item of group.remote) {
              if (item.kind === 'line' && item.data &&
                !selectedLive.some((row) => row.kind === 'line' && row.id === item.id))
                queue.push({ kind: 'line', recordId: item.id, op: 'delete' });
            }
          }
        }
        await storeProtocol(saved.cfg, protocol);
        await enqueueInTx(queue);
        await db.conflicts.clear();
        await db.remotePendingLines.clear();
        await db.remoteOrderUndo.clear();
        const baselineKey = `reconnect-baseline:${preview.scope}`;
        if (queue.length > 0) {
          if (!remote.expectedRows || remote.expectedRows.length > 10_000 || queue.length > 10_000)
            fail('reconnect snapshot exceeds 10000 row limit');
          await meta.put({ key: baselineKey, kind: 'reconnect-baseline', scope: preview.scope,
            operationId: crypto.randomUUID(), expectedRows: remote.expectedRows, generation: lease.generation,
            localFingerprint: preview.localFingerprint, remoteFingerprint: preview.remoteFingerprint, counts: preview.counts });
        } else await meta.delete(baselineKey);
        await meta.delete(`reconnect-recovery:${preview.scope}`);
        await meta.delete('recovery-pending');
        await assertLeaseCurrent(lease);
        return lease.generation;
      });
    });
    memory.delete(preview.token);
    const [url, ledger] = JSON.parse(preview.scope) as [string, string];
    localStorage.setItem('yh-sync-url', url);
    localStorage.setItem('yh-sync-anon', saved.cfg.anonKey.trim());
    localStorage.setItem('yh-sync-ledger', ledger);
    for (const suffix of ['last-pull', 'last-pull-id', 'last-replay', 'last-replay-cursor',
      'initial-pending', 'parent-lookup-after', 'cleared-at', 'last-sync', 'error'])
      localStorage.removeItem(`yh-sync-${suffix}`);
    localStorage.removeItem('yh-sync-disabled');
    await resumeSync(generation);
    return { generation };
  } finally { saved.confirming = false; }
}
