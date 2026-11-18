// 仅性能基准对照用：优化前 calc.ts 里 fifoAllocate 的排序实现（原样复制，不参与生产代码）。
// 用途：在同一进程里与优化后的实现交替采样，排除机器漂移造成的误判。
// 对应 2026-11-18 优化前的实现：口径若再次变更，请以 src/db/calc.ts 为准，
// 不要把「新旧不一致」直接当作回归。
import type { Batch, SaleLine, SalesOrder } from '../../src/db/types';

function batchOrderKey(b: Batch): string {
  return `${b.receivedAt}|${b.createdAt}|${b.id}`;
}

function productAvgCostFen(batches: Batch[]): Map<string, number> {
  const qty = new Map<string, number>();
  const cost = new Map<string, number>();
  for (const b of batches) {
    qty.set(b.productId, (qty.get(b.productId) ?? 0) + b.qtyBase);
    cost.set(b.productId, (cost.get(b.productId) ?? 0) + b.qtyBase * b.unitCostFen);
  }
  const avg = new Map<string, number>();
  for (const [pid, q] of qty) avg.set(pid, q > 0 ? Math.round((cost.get(pid) ?? 0) / q) : 0);
  return avg;
}

function takeFromBatches(
  arr: Batch[],
  startIdx: number,
  need: number,
  batchRemaining: Map<string, number>
): { cost: number; left: number; idx: number } {
  let idx = startIdx;
  let left = need;
  let cost = 0;
  while (left > 0 && idx < arr.length) {
    const b = arr[idx];
    const remain = batchRemaining.get(b.id) ?? 0;
    if (remain <= 0) {
      idx++;
      continue;
    }
    const take = Math.min(remain, left);
    cost += take * b.unitCostFen;
    batchRemaining.set(b.id, remain - take);
    left -= take;
    if (remain - take === 0) idx++;
  }
  return { cost, left, idx };
}

/** 优化前的 fifoAllocate（排序键在比较函数里现拼） */
export function fifoAllocateLegacy(batches: Batch[], orders: SalesOrder[], lines: SaleLine[]) {
  const orderTime = new Map<string, string>();
  for (const o of orders) if (!o.voided) orderTime.set(o.id, o.createdAt);

  const byProduct = new Map<string, Batch[]>();
  for (const b of batches) {
    const arr = byProduct.get(b.productId) ?? [];
    arr.push(b);
    byProduct.set(b.productId, arr);
  }
  for (const arr of byProduct.values()) {
    arr.sort((a, b) => {
      const ka = batchOrderKey(a);
      const kb = batchOrderKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

  const queueIdx = new Map<string, number>();
  const batchRemaining = new Map<string, number>();
  for (const b of batches) batchRemaining.set(b.id, b.qtyBase);
  const avgCost = productAvgCostFen(batches);

  const sorted = [...lines]
    .filter((l) => orderTime.has(l.orderId))
    .sort((a, b) => {
      const ta = orderTime.get(a.orderId)!;
      const tb = orderTime.get(b.orderId)!;
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const lineCost = new Map<string, number>();
  const uncoveredQtyByLine = new Map<string, number>();
  let uncoveredQty = 0;
  let uncoveredCostFen = 0;

  for (const line of sorted) {
    const arr = byProduct.get(line.productId) ?? [];
    const taken = takeFromBatches(
      arr,
      queueIdx.get(line.productId) ?? 0,
      line.qtyBase,
      batchRemaining
    );
    const need = taken.left;
    let got = taken.cost;
    if (need > 0) {
      const unit = avgCost.get(line.productId) ?? 0;
      got += need * unit;
      uncoveredQty += need;
      uncoveredCostFen += need * unit;
      uncoveredQtyByLine.set(line.id, need);
    }
    queueIdx.set(line.productId, taken.idx);
    lineCost.set(line.id, got);
  }

  return { lineCost, batchRemaining, uncoveredQty, uncoveredCostFen, uncoveredQtyByLine };
}