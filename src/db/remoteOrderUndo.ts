import { canonicalJson } from './canonical';
import type { SaleLine, SalesOrder } from './types';

/** 持久化的远端整单撤销快照。按 orderId 去重，最多保留最近 20 单。 */
export interface RemoteOrderUndoRow {
  orderId: string;
  capturedAt: number;
  beforeOrder: SalesOrder;
  beforeLines: SaleLine[];
  beforeFingerprint: string;
  beforeComplete: boolean;
  remoteVersionKey: string;
  remoteOrderLineIds?: string[];
  remoteOrderTotalFen?: number;
  afterFingerprint: string;
  canUndo: boolean;
  disabledReason?: string;
}

export function orderLineFingerprint(order: SalesOrder | undefined, lines: SaleLine[]): string {
  return canonicalJson({
    order: order ? { ...order, id: order.id } : null,
    lines: [...lines]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((line) => ({ ...line, id: line.id }))
  });
}

export function compareLineSetAndTotal(
  order: SalesOrder | undefined,
  lines: SaleLine[],
  expectedIds: string[] | undefined,
  expectedTotalFen: number | undefined
): boolean {
  if (!order || !expectedIds || !Number.isFinite(expectedTotalFen) || expectedTotalFen! < 0) return false;
  if (new Set(expectedIds).size !== expectedIds.length || expectedIds.some((id) => !id)) return false;
  if (lines.some((line) => line.orderId !== order.id || !Number.isFinite(line.qtyBase) || line.qtyBase <= 0 ||
    !Number.isFinite(line.amountFen) || line.amountFen < 0)) return false;
  const actual = [...new Set(lines.map((line) => line.id))].sort();
  if (actual.length !== lines.length) return false;
  const expected = [...expectedIds].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) return false;
  return lines.reduce((sum, line) => sum + line.amountFen, 0) === expectedTotalFen;
}

export function remoteOrderVersionKey(row: {
  id: string;
  updated_at: number;
  record_updated_at?: number;
  data?: unknown;
}): string {
  const business = Number(row.record_updated_at) || 0;
  const data = row.data && typeof row.data === 'object' ? row.data as Record<string, unknown> : {};
  const ids = Array.isArray(data.lineIds) && data.lineIds.every((id) => typeof id === 'string')
    ? [...data.lineIds as string[]].sort()
    : null;
  return `${row.id}:${business || Number(row.updated_at) || 0}:${ids === null ? 'legacy' : canonicalJson(ids)}`;
}

/** Date.now 与业务时间取最大值后再前进 1ms，保证撤销版本严格更新。 */
export function nextUndoUpdatedAt(...times: (string | undefined)[]): string {
  const max = times.reduce((value, time) => {
    const parsed = time ? Date.parse(time) : NaN;
    return Number.isFinite(parsed) ? Math.max(value, parsed) : value;
  }, Date.now());
  return new Date(max + 1).toISOString();
}
