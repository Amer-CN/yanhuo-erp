// 同步发件箱：所有本地写入都登记一条，联网后按 UUID 推送到云端。
// 离线时只写本地 + 这里，联网后自动补发。

import { db, type OutboxRow } from './db';

export type SyncKind = OutboxRow['kind'];

export function syncWanted(): void {
  try {
    window.dispatchEvent(new Event('yh-sync-wanted'));
  } catch {
    /* 非浏览器环境忽略 */
  }
}

export async function enqueue(
  kind: SyncKind,
  recordId: string,
  op: 'upsert' | 'delete' = 'upsert'
): Promise<void> {
  await db.outbox.put({
    id: `${kind}:${recordId}`,
    kind,
    recordId,
    op,
    queuedAt: Date.now()
  });
  syncWanted();
}

export async function enqueueMany(
  rows: { kind: SyncKind; recordId: string; op?: 'upsert' | 'delete' }[]
): Promise<void> {
  if (rows.length === 0) return;
  const now = Date.now();
  await db.outbox.bulkPut(
    rows.map((r, i) => ({
      id: `${r.kind}:${r.recordId}`,
      kind: r.kind,
      recordId: r.recordId,
      op: r.op ?? 'upsert',
      queuedAt: now + i
    }))
  );
  syncWanted();
}

export async function pendingCount(): Promise<number> {
  return db.outbox.count();
}

/** 把当前本地所有记录重新登记（合并/导入之后调用） */
export async function enqueueAllLocal(): Promise<void> {
  const [products, batches, orders, lines, adjustments, settings] = await Promise.all([
    db.products.toArray(),
    db.batches.toArray(),
    db.orders.toArray(),
    db.lines.toArray(),
    db.adjustments.toArray(),
    db.settings.toArray()
  ]);
  const rows: { kind: SyncKind; recordId: string; op?: 'upsert' }[] = [];
  for (const p of products) rows.push({ kind: 'product', recordId: p.id });
  for (const b of batches) rows.push({ kind: 'batch', recordId: b.id });
  for (const o of orders) rows.push({ kind: 'order', recordId: o.id });
  for (const l of lines) rows.push({ kind: 'line', recordId: l.id });
  for (const a of adjustments) rows.push({ kind: 'adjustment', recordId: a.id });
  for (const s of settings) rows.push({ kind: 'setting', recordId: s.key });
  await enqueueMany(rows);
}

export async function clearOutbox(): Promise<void> {
  await db.outbox.clear();
}