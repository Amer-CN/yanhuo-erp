import { describe, expect, it } from 'vitest';
import type { Adjustment, Batch, SaleLine, SalesOrder } from '../src/db/types';
import { expiryWarnings, fifoAllocate, inventoryMap } from '../src/db/calc';
import { fenToStr, qtyToStr, strToFen } from '../src/db/util';

function batch(id: string, qty: number, cost: number, date: string): Batch {
  return {
    id,
    productId: 'p1',
    qtyBase: qty,
    unitCostFen: cost,
    receivedAt: date,
    deviceId: 'd1',
    createdAt: `${date}T00:00:00.000Z`
  };
}

function order(id: string, iso: string, pay: SalesOrder['payMethod'], total: number, voided = false): SalesOrder {
  return {
    id,
    deviceId: 'd1',
    operator: '我',
    createdAt: iso,
    payMethod: pay,
    totalFen: total,
    voided
  };
}

function line(
  id: string,
  orderId: string,
  qtyBase: number,
  listPrice: number,
  unitPrice: number
): SaleLine {
  return {
    id,
    orderId,
    productId: 'p1',
    qtyBase,
    unit: 'base',
    qty: qtyBase,
    listUnitPriceFen: listPrice,
    unitPriceFen: unitPrice,
    amountFen: qtyBase * unitPrice,
    discountFen: (listPrice - unitPrice) * qtyBase
  };
}

describe('钱和数量的格式', () => {
  it('分转字符串', () => {
    expect(fenToStr(0)).toBe('0.00');
    expect(fenToStr(1250)).toBe('12.50');
    expect(fenToStr(5)).toBe('0.05');
    expect(fenToStr(-305)).toBe('-3.05');
  });

  it('字符串转分', () => {
    expect(strToFen('12.5')).toBe(1250);
    expect(strToFen('12')).toBe(1200);
    expect(strToFen('0.05')).toBe(5);
    expect(strToFen('¥12.50')).toBe(1250);
    expect(strToFen('abc')).toBeNull();
    expect(strToFen('12.345')).toBeNull();
    expect(strToFen('')).toBeNull();
  });

  it('数量显示拆箱', () => {
    expect(qtyToStr(35, 10, '个')).toBe('3 箱 + 5 个');
    expect(qtyToStr(30, 10, '个')).toBe('3 箱');
    expect(qtyToStr(5, 10, '个')).toBe('5 个');
    expect(qtyToStr(5, 0, '个')).toBe('5 个');
    expect(qtyToStr(-12, 10, '个')).toBe('-1 箱 + 2 个');
  });

  it('strToFen 处理负号、尾点、千分位，并拒绝三位小数', () => {
    // 负数：实现专门处理前导负号，fenToStr 也支持负号，两侧口径必须对称
    expect(strToFen('-3.05')).toBe(-305);
    expect(strToFen('-0.5')).toBe(-50);
    // 尾点：正则允许 '1.'，按 1 元计
    expect(strToFen('1.')).toBe(100);
    // 千分位与货币符号被显式剔除
    expect(strToFen('1,234.50')).toBe(123450);
    expect(strToFen('￥ 12.50')).toBe(1250);
    // 三位小数一律拒绝（不做隐式四舍五入）
    expect(strToFen('0.001')).toBeNull();
    expect(strToFen('1.005')).toBeNull();
    // 超大数仍在安全整数范围内：yuan*100+cents 不丢精度
    expect(strToFen('999999999999.99')).toBe(99999999999999);
  });

  it('fenToStr 处理超过 1e9 的分值与小数取整', () => {
    expect(fenToStr(1_000_000_000)).toBe('10000000.00');
    // 非整数分按 Math.round 取整后再显示
    expect(fenToStr(0.4)).toBe('0.00');
    expect(fenToStr(10.6)).toBe('0.11');
  });

  // 锁死：先取整再判符号，避免 -0.00。
  // 若反过来（先按 fen 判符号再 Math.round），Math.round(-0.4) === -0 会让符号取自原始值，
  // 输出就变成 '-0.00'；`rounded < 0` 对 -0 为 false，所以 -0 天然落到 '0.00'。
  it('fenToStr 先取整再判符号：非整数分不会出现 -0.00', () => {
    expect(fenToStr(-0.4)).toBe('0.00');
    expect(fenToStr(0.4)).toBe('0.00');
    expect(fenToStr(-100)).toBe('-1.00');
    expect(fenToStr(-1)).toBe('-0.01');
    expect(fenToStr(1e9)).toBe('10000000.00');
  });
});

describe('取整口径（负数半入方向）', () => {
  it('Math.round 是向 +∞ 取整而不是四舍五入：10.5→11、-2.5→-2', () => {
    expect(Math.round(10.5)).toBe(11);
    expect(Math.round(-2.5)).toBe(-2);
    // 落库侧（repo.ts 的数量/单价、createAdjustment）全部走 Math.round，
    // 一旦有人「顺手改成四舍五入」，负数方向会静默变化 —— 这里把方向钉死
    expect(Math.round(-2.4)).toBe(-2);
    expect(Math.round(-2.6)).toBe(-3);
  });
});

describe('库存与 FIFO 成本', () => {
  const batches = [batch('b1', 100, 100, '2026-01-01'), batch('b2', 100, 200, '2026-01-02')];
  const orders = [order('o1', '2026-01-02T02:00:00', 'cash', 45000)];
  const lines = [line('l1', 'o1', 150, 350, 300)];

  it('库存 = 进货 − 销售', () => {
    const inv = inventoryMap(batches, orders, lines, []);
    expect(inv.get('p1')).toBe(50);
  });

  it('FIFO 先吃早批次：100×100 + 50×200', () => {
    const fifo = fifoAllocate(batches, orders, lines);
    expect(fifo.lineCost.get('l1')).toBe(100 * 100 + 50 * 200);
    expect(fifo.batchRemaining.get('b1')).toBe(0);
    expect(fifo.batchRemaining.get('b2')).toBe(50);
    expect(fifo.uncoveredQty).toBe(0);
  });

  it('作废订单不计库存和成本', () => {
    const voided = [order('o1', '2026-01-02T02:00:00', 'cash', 45000, true)];
    const fifo = fifoAllocate(batches, voided, lines);
    const inv = inventoryMap(batches, voided, lines, []);
    expect(fifo.lineCost.size).toBe(0);
    expect(inv.get('p1')).toBe(200);
  });

  it('没有批次可扣时用均价兜底', () => {
    const small = [batch('b1', 100, 100, '2026-01-01')];
    const fifo = fifoAllocate(small, orders, lines);
    // 缺的 50 件按均价 100 算
    expect(fifo.lineCost.get('l1')).toBe(100 * 100 + 50 * 100);
    expect(fifo.uncoveredQty).toBe(50);
  });

  it('调整（盘亏）计入库存', () => {
    const adj: Adjustment = {
      id: 'a1',
      productId: 'p1',
      qtyBase: -5,
      type: 'loss',
      createdAt: '2026-01-03T00:00:00.000Z',
      deviceId: 'd1'
    };
    const inv = inventoryMap(batches, orders, lines, [adj]);
    expect(inv.get('p1')).toBe(45);
  });
});

describe('报表', () => {
  const batches = [batch('b1', 100, 100, '2026-01-01'), batch('b2', 100, 200, '2026-01-02')];
  const orders = [
    order('o1', '2026-01-02T02:00:00', 'cash', 45000),
    order('o2', '2026-01-02T03:00:00', 'wechat', 2000),
    order('o3', '2026-01-03T03:00:00', 'alipay', 1000)
  ];
  const lines = [
    line('l1', 'o1', 150, 350, 300),
    line('l2', 'o2', 40, 50, 50),
    line('l3', 'o3', 10, 100, 100)
  ];

  it('临期预警只看有剩余的批次', () => {
    const withExpiry = [
      { ...batches[0], expiryDate: '2026-01-20' },
      { ...batches[1], expiryDate: '2027-01-20' },
      batch('b3', 10, 100, '2026-01-05')
    ];
    const f2 = fifoAllocate(withExpiry, orders, lines);
    const warns = expiryWarnings(withExpiry, f2, () => '测试鞭炮', 30, '2026-01-10');
    // b1 已卖光；b3 没有效期；b2 在 30 天外
    expect(warns).toHaveLength(0);
  });

  it('窗口内的临期批次按 daysLeft 升序返回，已过期的排最前', () => {
    const today = '2026-01-10';
    const list = [
      { ...batch('b-soon', 10, 100, '2026-01-01'), expiryDate: '2026-01-15' }, // +5 天
      { ...batch('b-expired', 10, 100, '2026-01-01'), expiryDate: '2026-01-08' }, // -2 天
      { ...batch('b-far', 10, 100, '2026-01-01'), expiryDate: '2026-02-10' }, // +31 天，窗口外
      batch('b-noexp', 10, 100, '2026-01-01') // 没有有效期
    ];
    const fifo = fifoAllocate(list, [], []);

    const warns = expiryWarnings(list, fifo, () => '大地红', 30, today);

    // 排除 +31 天与无有效期；剩余两条按 daysLeft 升序（已过期在前）
    expect(warns.map((w) => w.batch.id)).toEqual(['b-expired', 'b-soon']);
    expect(warns.map((w) => w.daysLeft)).toEqual([-2, 5]);
    expect(warns[0].productName).toBe('大地红');
    expect(warns[0].remaining).toBe(10);
  });

  it('warnDays 边界：恰好落在预警上限当天的批次也算命中', () => {
    const today = '2026-01-10';
    // 2026-02-09 = today + 30 天，正好等于 limit
    const list = [{ ...batch('b-edge', 5, 100, '2026-01-01'), expiryDate: '2026-02-09' }];
    const fifo = fifoAllocate(list, [], []);

    const warns = expiryWarnings(list, fifo, () => 'p', 30, today);

    expect(warns).toHaveLength(1);
    expect(warns[0].daysLeft).toBe(30);
  });
});
