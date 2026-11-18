import type { Table } from 'dexie';
import { db, type OutboxRow } from './db';
import { canonicalJson } from './canonical';
import { SKIP_SETTINGS } from './outbox';
import { businessTime } from './syncResolve';
import { assertLeaseCurrent, pauseSync } from './syncControl';
import { protocolScope } from './syncProtocol';
import type { SyncConfig, SyncLease } from './syncTypes';

type Kind = OutboxRow['kind'];
export interface ReconnectProjectionRow {
  id: string;
  record_id: string;
  kind: string;
  data: unknown;
  updated_at: number;
  record_updated_at: number;
  deleted: boolean;
}
interface PushRow extends ReconnectProjectionRow {
  ledger: string;
  schema_version: number;
  clear_epoch: number;
  device_id: string;
}
interface Baseline {
  key: string;
  kind: 'reconnect-baseline';
  scope: string;
  generation: number;
  operationId: string;
  expectedRows: ReconnectProjectionRow[];
  sentPayload?: PushRow[];
  sentRows?: OutboxRow[];
}
interface Binding { key: string; scope: string; clearEpoch: number }
const meta = db.table<Baseline, string>('syncMeta');
const bindings = db.table<Binding, string>('syncMeta');
const tables = {
  product: db.products, batch: db.batches, order: db.orders, line: db.lines,
  adjustment: db.adjustments, session: db.sessions, setting: db.settings
} as unknown as Record<Kind, Table<Record<string, unknown>, string>>;
const LIMIT = 10_000;
const PAUSE_REASON = '重新连接基线已变化或云端尚未支持安全核对，请重新预览并确认；本地记录和待推送队列已保留';

function validateBaseline(row: Baseline, scope: string, lease: SyncLease): void {
  if (row.kind !== 'reconnect-baseline' || row.scope !== scope || row.generation !== lease.generation ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.operationId) ||
    !Array.isArray(row.expectedRows) || row.expectedRows.length > LIMIT ||
    ((row.sentPayload === undefined) !== (row.sentRows === undefined))) {
    throw new Error('重新连接基线缺失或已失效，请重新预览并确认');
  }
}

/** One immutable request per operation, stored before transport; no network runs in an IDB transaction. */
export async function pushReconnectBaseline(cfg: SyncConfig, lease: SyncLease): Promise<number | undefined> {
  const scope = protocolScope(cfg);
  const key = `reconnect-baseline:${scope}`;
  const [url, ledger] = JSON.parse(scope) as [string, string];
  const snapshot = await db.transaction('r', [db.outbox, db.syncMeta, ...Object.values(tables)], async () => {
    await assertLeaseCurrent(lease);
    const baseline = await meta.get(key);
    if (!baseline) return undefined;
    validateBaseline(baseline, scope, lease);
    const binding = await bindings.get('sync-binding');
    if (!binding || binding.scope !== scope || !Number.isSafeInteger(binding.clearEpoch) || binding.clearEpoch < 0)
      throw new Error('重新连接账本绑定已变化，请重新预览并确认');
    if (baseline.sentPayload && baseline.sentRows) return { baseline, binding };
    const rows = await db.outbox.toArray();
    if (rows.length > LIMIT) throw new Error('重新连接待推送超过 10000 行，请先整理后重新核对');
    const device = (await db.settings.get('deviceId'))?.value ?? '';
    const sentPayload: PushRow[] = [];
    for (const row of rows) {
      if (!(row.kind in tables) || row.id !== `${row.kind}:${row.recordId}` ||
        (row.scope !== undefined && row.scope !== scope) || (row.clearEpoch ?? 0) !== binding.clearEpoch)
        throw new Error('重新连接待推送账本或清空代际已变化，请重新预览并确认');
      if (row.kind === 'setting' && SKIP_SETTINGS.has(row.recordId)) continue;
      const local = row.op === 'delete' ? undefined : await tables[row.kind].get(row.recordId);
      if (row.op !== 'delete' && !local) throw new Error(`重新连接待推送 upsert 本地记录缺失：${row.id}`);
      sentPayload.push({ id: row.id, record_id: row.recordId, ledger, kind: row.kind, data: local ?? {},
        updated_at: Date.now(), record_updated_at: businessTime(local), deleted: row.op === 'delete',
        schema_version: 2, clear_epoch: binding.clearEpoch, device_id: device });
    }
    return { baseline: { ...baseline, sentPayload, sentRows: rows }, binding };
  });
  if (!snapshot) return undefined;
  const baseline = await db.transaction('rw', [db.outbox, db.syncMeta], async () => {
    await assertLeaseCurrent(lease);
    const current = await meta.get(key);
    if (!current || current.operationId !== snapshot.baseline.operationId)
      throw new Error('重新连接基线已变化，请重新预览并确认');
    validateBaseline(current, scope, lease);
    const binding = await bindings.get('sync-binding');
    if (canonicalJson(binding) !== canonicalJson(snapshot.binding))
      throw new Error('重新连接账本绑定已变化，请重新预览并确认');
    const sent = current.sentPayload ? current : snapshot.baseline;
    await meta.put(sent);
    return sent;
  });
  const controller = new AbortController();
  const abort = () => controller.abort(lease.signal.reason);
  if (lease.signal.aborted) abort(); else lease.signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let pausedHere = false;
  try {
    await assertLeaseCurrent(lease);
    const anonKey = cfg.anonKey.trim();
    const response = await fetch(`${url}/rest/v1/rpc/yh_reconcile_push`, { method: 'POST',
      headers: { apikey: anonKey, ...(anonKey.startsWith('eyJ') ? { Authorization: `Bearer ${anonKey}` } : {}),
        'x-ledger-key': ledger, 'x-yh-clear-epoch': String(snapshot.binding.clearEpoch),
        'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ p_operation_id: baseline.operationId, p_expected: baseline.expectedRows, p_rows: baseline.sentPayload }),
      signal: controller.signal });
    const text = await response.text();
    await assertLeaseCurrent(lease);
    if (!response.ok) {
      if (response.status === 404 || /SYNC_RECONNECT_BASELINE_CHANGED/.test(text)) {
        await pauseSync(PAUSE_REASON);
        pausedHere = true;
        localStorage.setItem('yh-sync-disabled', '1');
        throw new Error(PAUSE_REASON);
      }
      throw new Error(`重新连接核对失败（HTTP ${response.status}）：${text.slice(0, 300)}`);
    }
    const receipt: unknown = JSON.parse(text);
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
      (receipt as { operationId?: unknown }).operationId !== baseline.operationId ||
      (receipt as { pushedCount?: unknown }).pushedCount !== baseline.sentPayload!.length)
      throw new Error('重新连接核对回执无效；保留同一操作等待重试');
    await db.transaction('rw', [db.outbox, db.syncMeta], async () => {
      await assertLeaseCurrent(lease);
      const current = await meta.get(key);
      if (!current || current.operationId !== baseline.operationId ||
        canonicalJson(current.sentRows) !== canonicalJson(baseline.sentRows) ||
        canonicalJson(current.sentPayload) !== canonicalJson(baseline.sentPayload))
        throw new Error('重新连接基线已变化，回执不能确认新队列');
      const queued = await db.outbox.bulkGet(baseline.sentRows!.map(row => row.id));
      const ids = baseline.sentRows!.filter((sent, i) => {
        const row = queued[i];
        if (!row) return false;
        return sent.revision !== undefined ? row.revision === sent.revision :
          row.revision === undefined && row.queuedAt === sent.queuedAt && row.op === sent.op;
      }).map(row => row.id);
      await db.outbox.bulkDelete(ids);
      await meta.delete(key);
    });
    return baseline.sentPayload!.length;
  } catch (error) {
    // A pause/restore invalidates the run; it must never be reclassified as a network failure.
    if (!pausedHere) await assertLeaseCurrent(lease);
    if (error instanceof Error && error.name === 'AbortError') throw new Error('云端无响应（超时），同一重新连接操作稍后重试');
    throw error;
  } finally {
    clearTimeout(timeout);
    lease.signal.removeEventListener('abort', abort);
  }
}
