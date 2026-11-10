// 核心计算：库存、FIFO 成本、日报、单品毛利、临期预警。
// 原则：库存和毛利都是「算出来的」，不落库；合并后重算永远一致。

import type { Adjustment, Batch, SaleLine, SalesOrder, SessionSummary } from './types';
import { addDays, localDate } from './util';

/** 有效订单（排除整单作废） */
export function activeOrderIds(orders: SalesOrder[]): Set<string> {
  const s = new Set<string>();
  for (const o of orders) if (!o.voided) s.add(o.id);
  return s;
}

/** 各商品当前库存（基本单位，可为负——负库存说明超卖或漏录进货） */
export function inventoryMap(
  batches: Batch[],
  orders: SalesOrder[],
  lines: SaleLine[],
  adjustments: Adjustment[]
): Map<string, number> {
  const active = activeOrderIds(orders);
  const m = new Map<string, number>();
  const add = (pid: string, q: number) => m.set(pid, (m.get(pid) ?? 0) + q);
  for (const b of batches) add(b.productId, b.qtyBase);
  for (const l of lines) if (active.has(l.orderId)) add(l.productId, -l.qtyBase);
  for (const a of adjustments) add(a.productId, a.qtyBase);
  return m;
}

export interface FifoResult {
  /** 明细 → 成本（分） */
  lineCost: Map<string, number>;
  /** 批次 → 剩余（基本单位） */
  batchRemaining: Map<string, number>;
  /** 没有批次可扣的销量（漏录进货 / 超卖） */
  uncoveredQty: number;
  /** 兜底成本（分）：按该商品已有的平均进价估算 */
  uncoveredCostFen: number;
}

/**
 * 各商品加权平均进价（分/基本单位）。用于成本缺失时的兜底估算，
 * 以及记账页给赠品显示"约 ¥X 成本"。
 */
export function productAvgCostFen(batches: Batch[]): Map<string, number> {
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

/**
 * FIFO 成本重放：进货批次按到货时间先进先出，销售明细按时间顺序扣批。
 * 两台设备的数据合并后按时间重排，结果就是合并后的真实成本。
 */
export function fifoAllocate(
  batches: Batch[],
  orders: SalesOrder[],
  lines: SaleLine[]
): FifoResult {
  const orderTime = new Map<string, string>();
  for (const o of orders) if (!o.voided) orderTime.set(o.id, o.createdAt);

  // 批次排队：到货时间 → 创建时间 → id
  const byProduct = new Map<string, Batch[]>();
  for (const b of batches) {
    const arr = byProduct.get(b.productId) ?? [];
    arr.push(b);
    byProduct.set(b.productId, arr);
  }
  for (const arr of byProduct.values()) {
    arr.sort((a, b) => {
      const ka = `${a.receivedAt}|${a.createdAt}|${a.id}`;
      const kb = `${b.receivedAt}|${b.createdAt}|${b.id}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

  const queueIdx = new Map<string, number>();
  const batchRemaining = new Map<string, number>();
  for (const b of batches) batchRemaining.set(b.id, b.qtyBase);

  // 商品兜底均价（分/基本单位）
  const avgCost = productAvgCostFen(batches);

  // 销售明细按订单时间排序
  const sorted = [...lines]
    .filter((l) => orderTime.has(l.orderId))
    .sort((a, b) => {
      const ta = orderTime.get(a.orderId)!;
      const tb = orderTime.get(b.orderId)!;
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const lineCost = new Map<string, number>();
  let uncoveredQty = 0;
  let uncoveredCostFen = 0;

  for (const line of sorted) {
    let need = line.qtyBase;
    let got = 0;
    let idx = queueIdx.get(line.productId) ?? 0;
    const arr = byProduct.get(line.productId) ?? [];

    while (need > 0 && idx < arr.length) {
      const b = arr[idx];
      const remain = batchRemaining.get(b.id) ?? 0;
      if (remain <= 0) {
        idx++;
        continue;
      }
      const take = Math.min(remain, need);
      got += take * b.unitCostFen;
      batchRemaining.set(b.id, remain - take);
      need -= take;
      if (remain - take === 0) idx++;
    }

    if (need > 0) {
      const unit = avgCost.get(line.productId) ?? 0;
      got += need * unit;
      uncoveredQty += need;
      uncoveredCostFen += need * unit;
    }

    queueIdx.set(line.productId, idx);
    lineCost.set(line.id, got);
  }

  return { lineCost, batchRemaining, uncoveredQty, uncoveredCostFen };
}

export interface ProductMargin {
  productId: string;
  name: string;
  qtyBase: number;
  revenueFen: number;
  costFen: number;
  grossFen: number;
  discountFen: number;
  giftQty?: number;
  giftCostFen?: number;
  /** 该商品在本场有销量没有批次可扣（成本是估算的） */
  costIncomplete?: boolean;
}

/** 收款汇总：cash 记现金，wechat 记微信，其余一律记支付宝（沿用既有语义） */
function sumPayments(orders: SalesOrder[]): {
  cashFen: number;
  wechatFen: number;
  alipayFen: number;
  revenueFen: number;
} {
  let cashFen = 0;
  let wechatFen = 0;
  let alipayFen = 0;
  let revenueFen = 0;
  for (const o of orders) {
    if (o.payMethod === 'cash') cashFen += o.totalFen;
    else if (o.payMethod === 'wechat') wechatFen += o.totalFen;
    else alipayFen += o.totalFen;
    revenueFen += o.totalFen;
  }
  return { cashFen, wechatFen, alipayFen, revenueFen };
}

/**
 * 场次汇总：只统计属于该场次、且未作废的单。
 * 收款按 payMethod；成本含赠品行；赠品不让利。
 */
export function sessionReport(
  sessionId: string,
  orders: SalesOrder[],
  lines: SaleLine[],
  fifo: FifoResult
): SessionSummary {
  const sel = orders.filter((o) => o.sessionId === sessionId && !o.voided);
  const orderIds = new Set(sel.map((o) => o.id));
  const selLines = lines.filter((l) => orderIds.has(l.orderId));

  const { cashFen: cash, wechatFen: wechat, alipayFen: alipay, revenueFen: revenue } =
    sumPayments(sel);

  let cost = 0;
  let discount = 0;
  let giftCost = 0;
  let giftQty = 0;
  for (const l of selLines) {
    const lineCost = fifo.lineCost.get(l.id) ?? 0;
    cost += lineCost;
    if (l.gift) {
      giftCost += lineCost;
      giftQty += l.qtyBase;
    } else {
      // 赠品行即使历史数据里带了 discountFen，也不计入让利
      discount += l.discountFen;
    }
  }

  return {
    orderCount: sel.length,
    lineCount: selLines.length,
    revenueFen: revenue,
    cashFen: cash,
    wechatFen: wechat,
    alipayFen: alipay,
    costFen: cost,
    grossFen: revenue - cost,
    discountFen: discount,
    giftCostFen: giftCost,
    giftQty
  };
}

/** 单品毛利（按场次）；成本缺失的商品排在最后 */
export function productMarginsBySession(
  sessionId: string,
  orders: SalesOrder[],
  lines: SaleLine[],
  fifo: FifoResult,
  productName: (id: string) => string
): ProductMargin[] {
  const orderIds = new Set(
    orders.filter((o) => o.sessionId === sessionId && !o.voided).map((o) => o.id)
  );
  const m = new Map<string, ProductMargin>();
  for (const l of lines) {
    if (!orderIds.has(l.orderId)) continue;
    const cur = m.get(l.productId) ?? {
      productId: l.productId,
      name: productName(l.productId),
      qtyBase: 0,
      revenueFen: 0,
      costFen: 0,
      grossFen: 0,
      discountFen: 0,
      giftQty: 0,
      giftCostFen: 0,
      costIncomplete: false
    };
    const lineCost = fifo.lineCost.get(l.id);
    // 该明细没有任何批次可扣（漏录进货/超卖），成本是缺失的，不只是 0
    if (lineCost === undefined) cur.costIncomplete = true;
    cur.qtyBase += l.qtyBase;
    cur.revenueFen += l.amountFen;
    cur.costFen += lineCost ?? 0;
    if (l.gift) {
      cur.giftQty = (cur.giftQty ?? 0) + l.qtyBase;
      cur.giftCostFen = (cur.giftCostFen ?? 0) + (lineCost ?? 0);
    } else {
      cur.discountFen += l.discountFen;
    }
    m.set(l.productId, cur);
  }
  for (const v of m.values()) v.grossFen = v.revenueFen - v.costFen;
  return [...m.values()].sort((a, b) => {
    if (a.costIncomplete !== b.costIncomplete) return a.costIncomplete ? 1 : -1;
    return b.grossFen - a.grossFen;
  });
}

export function emptySessionSummary(): SessionSummary {
  return {
    orderCount: 0,
    lineCount: 0,
    revenueFen: 0,
    cashFen: 0,
    wechatFen: 0,
    alipayFen: 0,
    costFen: 0,
    grossFen: 0,
    discountFen: 0,
    giftCostFen: 0,
    giftQty: 0
  };
}

export interface ExpiryWarning {
  batch: Batch;
  productName: string;
  remaining: number;
  daysLeft: number;
}

/** 临期/过期批次（剩余 > 0 且有效期在 warnDays 内） */
export function expiryWarnings(
  batches: Batch[],
  fifo: FifoResult,
  productName: (id: string) => string,
  warnDays: number,
  today: string = localDate()
): ExpiryWarning[] {
  const limit = addDays(today, warnDays);
  const out: ExpiryWarning[] = [];
  for (const b of batches) {
    if (!b.expiryDate) continue;
    const remaining = fifo.batchRemaining.get(b.id) ?? 0;
    if (remaining <= 0) continue;
    if (b.expiryDate > limit) continue;
    const daysLeft = Math.round(
      (new Date(`${b.expiryDate}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 86400000
    );
    out.push({ batch: b, productName: productName(b.productId), remaining, daysLeft });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

export interface BatchStockRow {
  batch: Batch;
  remaining: number;
}

/** 某个商品的批次剩余明细 */
export function batchStock(batches: Batch[], productId: string, fifo: FifoResult): BatchStockRow[] {
  return batches
    .filter((b) => b.productId === productId)
    .map((b) => ({ batch: b, remaining: fifo.batchRemaining.get(b.id) ?? 0 }))
    .sort((a, b) => (a.batch.receivedAt < b.batch.receivedAt ? -1 : 1));
}