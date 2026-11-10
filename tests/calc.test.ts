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
});
