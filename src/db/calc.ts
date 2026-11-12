// 核心计算：库存、FIFO 成本、场次汇总、单品毛利、临期预警。
// 原则：库存和毛利都是「算出来的」，不落库；合并后重算永远一致。

import type { Adjustment, Batch, SaleLine, SalesOrder, Session, SessionSummary } from './types';
import { addDays, isoToLocalDate, localDate, MS_PER_DAY } from './util';

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
  /**
   * 明细 → 没批次可扣的销量（基本单位）；成本完整的明细不在表里。
   *
   * 加这个表是为了让「成本是否缺失」可以**按场次**判断（H2）：
   * 以前只有全局 `uncoveredQty`，别的场次缺一批货就整页毛利变「—」，
   * 而同一页的复制文本却照样打印毛利金额，两处口径互相打脸。
   */
  uncoveredQtyByLine: Map<string, number>;
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
 * 批次 FIFO 排序键：到货日 → 创建时间 → id。
 *
 * 这是「批次排队口径」的唯一来源：`fifoAllocate` 的批次排序与
 * `repo.createBatch` 里「新批次是否插在队尾」的判定（isFifoLast）必须逐字节一致，
 * 否则补录进货后该重算的已结账快照会被静默跳过，历史成本长期偏差且不报错。
 *
 * 注意：`receivedAt` 按原样插值，不做 `|| createdAt` 兜底——`Batch.receivedAt`
 * 在类型与写入路径上都必填，兜底会悄悄改变既有口径。
 */
export function batchOrderKey(b: Batch): string {
  return `${b.receivedAt}|${b.createdAt}|${b.id}`;
}

/** 从某商品的批次队列按 FIFO 扣 need；返回扣到的成本、剩余需求与新队列下标 */
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
      const ka = batchOrderKey(a);
      const kb = batchOrderKey(b);
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
  /** 该商品在本场缺批次的销量（基本单位）；> 0 时 costIncomplete 必为 true */
  uncoveredQty?: number;
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
 * 场次汇总（比 `SessionSummary` 多三项「对账说明」字段）。
 *
 * `voidedCount` / `voidedFen` 是**被排除在外**的删除单，单独给出，好让报表写
 * 「销售额 ¥389.50 · 已排除 2 笔删除（¥83.00）」—— 否则作废单在报表里等于没发生过，
 * 摊主对不上账时无从下手。
 *
 * `uncoveredQty` 是**本场**缺批次的销量，用于按场次判断毛利能否展示（H2）。
 */
export interface SessionReport extends SessionSummary {
  voidedCount: number;
  voidedFen: number;
  uncoveredQty: number;
}

/**
 * 场次汇总：只统计属于该场次、且未作废的单。
 * 收款按 payMethod；成本含赠品行；赠品不让利。
 *
 * 作废单不再「filter 掉就没影了」：`voidedCount/voidedFen` 把它记成
 * 「已排除」，只影响说明行，不参与销售额/成本。
 */
export function sessionReport(
  sessionId: string,
  orders: SalesOrder[],
  lines: SaleLine[],
  fifo: FifoResult
): SessionReport {
  const sel = orders.filter((o) => o.sessionId === sessionId && !o.voided);
  const orderIds = new Set(sel.map((o) => o.id));
  const selLines = lines.filter((l) => orderIds.has(l.orderId));

  const { cashFen: cash, wechatFen: wechat, alipayFen: alipay, revenueFen: revenue } =
    sumPayments(sel);

  let cost = 0;
  let discount = 0;
  let giftCost = 0;
  let giftQty = 0;
  // 本场缺批次的销量（基本单位）：按明细汇总 fifo 的逐行缺失量
  let uncoveredQty = 0;
  for (const l of selLines) {
    const lineCost = fifo.lineCost.get(l.id) ?? 0;
    cost += lineCost;
    uncoveredQty += fifo.uncoveredQtyByLine.get(l.id) ?? 0;
    if (l.gift) {
      giftCost += lineCost;
      giftQty += l.qtyBase;
    } else {
      // 赠品行即使历史数据里带了 discountFen，也不计入让利
      discount += l.discountFen;
    }
  }

  let voidedCount = 0;
  let voidedFen = 0;
  for (const o of orders) {
    if (o.sessionId !== sessionId || !o.voided) continue;
    voidedCount += 1;
    voidedFen += o.totalFen;
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
    giftQty,
    voidedCount,
    voidedFen,
    uncoveredQty
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
      costIncomplete: false,
      uncoveredQty: 0
    };
    const lineCost = fifo.lineCost.get(l.id);
    // 防御：fifo 与 orders 不同步时（陈旧 FifoResult）该明细没有成本记录。
    // 注意「漏录进货」不走这里——那种情况 fifo 用兜底均价记 0，不是 undefined。
    if (lineCost === undefined) cur.costIncomplete = true;
    // H3：没有批次可扣的销量（漏录进货 / 超卖）成本是**估算**的。
    // 以前这里没赋值，于是「手持烟花棒 成本 ¥0、毛利 +¥20」显示成绿色盈利，
    // 摊主会拿这个数去定价。现在标 costIncomplete，表格打「成本待补」+ 毛利加 ~。
    const missing = fifo.uncoveredQtyByLine.get(l.id) ?? 0;
    if (missing > 0) {
      cur.costIncomplete = true;
      cur.uncoveredQty = (cur.uncoveredQty ?? 0) + missing;
    }
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

/**
 * 「今天」按日汇总：只累加**结账时间（closedAt）落在指定本地日**的已结账场次。
 *
 * 为什么按 closedAt 而不是 startedAt / 单据时间：
 * 收摊结账才是「这一场算完了」的那一刻；用 startedAt 会把跨零点的场次算到前一天，
 * 用单据时间又会把「22:00 新开、还没结账」的那一场混进今天（正是 H1 报的错——
 * 摊主收摊后看到的是下一场的 ¥16.00）。
 *
 * 进行中的场次不并入合计，只单独给出场次与金额，由界面写成
 * 「还有 1 场进行中 · ¥16.00（不计入今天）」。
 *
 * 纯函数：不读库、不看当前时间以外的状态（date 可由调用方传入，便于测试）。
 */
export interface DayReport extends SessionSummary {
  /** 本地日期 YYYY-MM-DD */
  date: string;
  /** 已结账的场次数 */
  sessionCount: number;
  /** 其中成本待补（缺批次）的场次数 */
  costIncompleteSessions: number;
  /** 已结账场次的成本是否完整——只有 true 时毛利数字才可展示 */
  grossKnown: boolean;
  /** 今天仍在进行中的场次数（不计入上面的合计） */
  openSessionCount: number;
  /** 进行中场次的销售额（仅用于「不计入今天」那行说明） */
  openRevenueFen: number;
  /** 已结账场次里被排除的删除单 */
  voidedCount: number;
  voidedFen: number;
}

export function dayReport(
  sessions: Session[],
  orders: SalesOrder[],
  lines: SaleLine[],
  fifo: FifoResult,
  date: string = localDate()
): DayReport {
  const out: DayReport = {
    date,
    sessionCount: 0,
    costIncompleteSessions: 0,
    grossKnown: true,
    openSessionCount: 0,
    openRevenueFen: 0,
    voidedCount: 0,
    voidedFen: 0,
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

  for (const s of sessions) {
    if (s.status === 'closed') {
      if (!s.closedAt || isoToLocalDate(s.closedAt) !== date) continue;
      const rep = sessionReport(s.id, orders, lines, fifo);
      out.sessionCount += 1;
      out.orderCount += rep.orderCount;
      out.lineCount += rep.lineCount;
      out.revenueFen += rep.revenueFen;
      out.cashFen += rep.cashFen;
      out.wechatFen += rep.wechatFen;
      out.alipayFen += rep.alipayFen;
      out.costFen += rep.costFen;
      out.grossFen += rep.grossFen;
      out.discountFen += rep.discountFen;
      out.giftCostFen += rep.giftCostFen;
      out.giftQty += rep.giftQty;
      out.voidedCount += rep.voidedCount;
      out.voidedFen += rep.voidedFen;
      if (rep.uncoveredQty > 0) out.costIncompleteSessions += 1;
      continue;
    }
    // 进行中：没有 closedAt，只能按开场时间判断「是不是今天开的这一场」
    if (isoToLocalDate(s.startedAt) !== date) continue;
    const rep = sessionReport(s.id, orders, lines, fifo);
    out.openSessionCount += 1;
    out.openRevenueFen += rep.revenueFen;
  }

  out.grossKnown = out.costIncompleteSessions === 0;
  return out;
}

export function emptySessionSummary(): SessionReport {
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
    giftQty: 0,
    voidedCount: 0,
    voidedFen: 0,
    uncoveredQty: 0
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
      (new Date(`${b.expiryDate}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / MS_PER_DAY
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