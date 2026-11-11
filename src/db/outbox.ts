// 同步发件箱：所有本地写入都登记一条，联网后按 UUID 推送到云端。
// 离线时只写本地 + 这里，联网后自动补发。

import { db, type OutboxRow } from './db';

export type SyncKind = OutboxRow['kind'];

/** 本机诊断键：记录见过的未知 kind，不参与云同步 */
export const UNKNOWN_KINDS_KEY = 'sync-unknown-kinds';

/**
 * 本机专属设置键：既**不参与云同步**（pull / push 两侧都过滤），也**不进发件箱**。
 *
 * - `deviceId` / `deviceName`：设备身份。一旦互相同步，两台手机会互相覆盖，
 *   本机场次按错误的 deviceId 过滤后立刻「找不到」；
 * - `operatorSelf`：本机操作人编号（一台手机 = 一个人）。同步会让两台手机的编号互相覆盖
 *   （「我明明设的 001，怎么变成 002 了」）；
 * - `sync-unknown-kinds`：本机诊断键，不属于任何业务数据。
 *
 * 定义放在 outbox 而不是 sync：入队处（`buildRows`）也要用它，
 * 让「不该同步」在写发件箱时就断掉，不必等到推送时才跳过。
 */
export const SKIP_SETTINGS = new Set<string>([
  'deviceId',
  'deviceName',
  'operatorSelf',
  UNKNOWN_KINDS_KEY
]);

/** 一次入队请求（事务内外共用） */
export interface OutboxItem {
  kind: SyncKind;
  recordId: string;
  op?: 'upsert' | 'delete';
}

export function syncWanted(): void {
  try {
    window.dispatchEvent(new Event('yh-sync-wanted'));
  } catch {
    /* 非浏览器环境忽略 */
  }
}

/**
 * 组装发件箱行：主键 `${kind}:${recordId}` 天然去重，同一记录多次改动合并成一条；
 * `queuedAt` 用同一时刻 + 序号，保证同一批内的推送顺序稳定。
 */
function buildRows(rows: OutboxItem[], now: number = Date.now()): OutboxRow[] {
  // 本机专属键在**入队处**就断掉（L-2）：同步侧本来也会跳过，但那样每次改 operatorSelf、
  // 每次整库标记都会塞进一条注定被丢弃的发件箱行，还要多跑一次推送往返才把它删掉。
  return rows
    .filter((r) => !(r.kind === 'setting' && SKIP_SETTINGS.has(r.recordId)))
    .map((r, i) => ({
      id: `${r.kind}:${r.recordId}`,
      kind: r.kind,
      recordId: r.recordId,
      op: r.op ?? 'upsert',
      queuedAt: now + i
    }));
}

export async function enqueue(
  kind: SyncKind,
  recordId: string,
  op: 'upsert' | 'delete' = 'upsert'
): Promise<void> {
  await db.outbox.put(buildRows([{ kind, recordId, op }])[0]);
  syncWanted();
}

export async function enqueueMany(rows: OutboxItem[]): Promise<void> {
  if (rows.length === 0) return;
  await db.outbox.bulkPut(buildRows(rows));
  syncWanted();
}

/**
 * 在**既有 Dexie 事务内**登记发件箱（对应 M-1：业务写入与入队必须同事务）。
 *
 * 调用前提：外层事务的表清单必须包含 `db.outbox`，例如
 * `db.transaction('rw', [db.orders, db.lines, db.outbox], …)`；
 * 否则 Dexie 会抛 `TransactionScopeError`（outbox 不在事务范围内）。
 *
 * 与 `enqueue` / `enqueueMany` 的区别：
 * - 不 dispatch `syncWanted()`：事件回调会立刻发起同步，事务尚未提交时去读会读到旧状态，
 *   所以由调用方在事务提交之后统一 `syncWanted()`；
 * - 不做任何重试：入队失败会**连同业务写入一起回滚**，这正是要的原子性。
 */
export async function enqueueInTx(rows: OutboxItem[]): Promise<void> {
  if (rows.length === 0) return;
  await db.outbox.bulkPut(buildRows(rows));
}

export async function pendingCount(): Promise<number> {
  return db.outbox.count();
}

/** 把当前本地所有记录重新登记（合并/导入之后调用） */
export async function enqueueAllLocal(): Promise<void> {
  const [products, batches, orders, lines, adjustments, sessions, settings] = await Promise.all([
    db.products.toArray(),
    db.batches.toArray(),
    db.orders.toArray(),
    db.lines.toArray(),
    db.adjustments.toArray(),
    db.sessions.toArray(),
    db.settings.toArray()
  ]);
  const rows: { kind: SyncKind; recordId: string; op?: 'upsert' }[] = [];
  for (const p of products) rows.push({ kind: 'product', recordId: p.id });
  for (const b of batches) rows.push({ kind: 'batch', recordId: b.id });
  for (const o of orders) rows.push({ kind: 'order', recordId: o.id });
  for (const l of lines) rows.push({ kind: 'line', recordId: l.id });
  for (const a of adjustments) rows.push({ kind: 'adjustment', recordId: a.id });
  for (const s of sessions) rows.push({ kind: 'session', recordId: s.id });
  for (const s of settings) rows.push({ kind: 'setting', recordId: s.key });
  await enqueueMany(rows);
}

export async function clearOutbox(): Promise<void> {
  await db.outbox.clear();
}