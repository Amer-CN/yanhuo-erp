import { describe, expect, it } from 'vitest';
import type { Batch, SaleLine, SalesOrder, Session } from '../src/db/types';
import { fifoAllocate, productMarginsBySession, sessionReport } from '../src/db/calc';
import { groupOrdersBySession, mergeSessionPair } from '../src/db/sessionLogic';

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

function order(
  id: string,
  iso: string,
  totalFen: number,
  sessionId: string,
  pay: SalesOrder['payMethod'] = 'cash',
  voided = false
): SalesOrder {
  return {
    id,
    deviceId: 'd1',
    operator: '我',
    createdAt: iso,
    payMethod: pay,
    totalFen,
    sessionId,
    voided
  };
}

function line(
  id: string,
  orderId: string,
  qtyBase: number,
  listUnitPriceFen: number,
  amountFen: number,
  gift = false
): SaleLine {
  return {
    id,
    orderId,
    productId: 'p1',
    qtyBase,
    unit: 'base',
    qty: qtyBase,
    listUnitPriceFen,
    unitPriceFen: gift ? 0 : Math.round(amountFen / qtyBase),
    amountFen,
    discountFen: gift ? 0 : Math.max(0, listUnitPriceFen * qtyBase - amountFen),
    ...(gift ? { gift: true } : {})
  };
}

describe('场次汇总', () => {
  const batches = [batch('b1', 100, 100, '2026-01-01')];
  const orders = [
    order('o1', '2026-01-01T10:00:00', 9000, 's1', 'cash'),
    order('o2', '2026-01-01T11:00:00', 2000, 's1', 'wechat'),
    order('o3', '2026-01-01T12:00:00', 1000, 's2', 'alipay'),
    order('o4', '2026-01-01T13:00:00', 500, 's1', 'cash', true)
  ];
  const lines = [
    line('l1', 'o1', 10, 1000, 9000),
    line('l2', 'o1', 5, 500, 0, true),
    line('l2b', 'o2', 2, 1000, 2000),
    line('l3', 'o3', 2, 500, 1000),
    line('l4', 'o4', 1, 500, 500)
  ];

  it('单数 / 销售额 / 收款 / 成本 / 让利', () => {
    const fifo = fifoAllocate(batches, orders, lines);
    const rep = sessionReport('s1', orders, lines, fifo);

    expect(rep.orderCount).toBe(2);
    expect(rep.lineCount).toBe(3);
    expect(rep.revenueFen).toBe(9000 + 2000);
    expect(rep.cashFen).toBe(9000);
    expect(rep.wechatFen).toBe(2000);
    expect(rep.alipayFen).toBe(0);
    // l1 = 10×100，l2b = 2×100，l2（赠品）= 5×100
    expect(rep.costFen).toBe(1700);
    expect(rep.grossFen).toBe(11000 - 1700);
    // 只有普通行让利：1000×10 − 9000
    expect(rep.discountFen).toBe(1000);
  });

  it('赠品：金额 0、不让利、成本照算', () => {
    const fifo = fifoAllocate(batches, orders, lines);
    const rep = sessionReport('s1', orders, lines, fifo);

    expect(rep.giftQty).toBe(5);
    expect(rep.giftCostFen).toBe(500);
    // 赠品行的标价 500×5 不计入让利
    expect(rep.discountFen).toBe(1000);
  });

  it('作废单不计入场次', () => {
    const fifo = fifoAllocate(batches, orders, lines);
    const rep = sessionReport('s1', orders, lines, fifo);
    expect(rep.orderCount).toBe(2);
    expect(rep.revenueFen).toBe(11000);
  });

  it('按场次统计单品毛利，赠品单独计数', () => {
    const fifo = fifoAllocate(batches, orders, lines);
    const m = productMarginsBySession('s1', orders, lines, fifo, () => '大地红');
    expect(m).toHaveLength(1);
    expect(m[0].qtyBase).toBe(17);
    expect(m[0].revenueFen).toBe(11000);
    expect(m[0].costFen).toBe(1700);
    expect(m[0].grossFen).toBe(9300);
    expect(m[0].giftQty).toBe(5);
    expect(m[0].giftCostFen).toBe(500);
    expect(m[0].discountFen).toBe(1000);
  });

  it('空场次全为 0', () => {
    const fifo = fifoAllocate(batches, orders, lines);
    const rep = sessionReport('nope', orders, lines, fifo);
    expect(rep.orderCount).toBe(0);
    expect(rep.revenueFen).toBe(0);
    expect(rep.giftQty).toBe(0);
  });
});

describe('历史订单迁移分组', () => {
  it('同日超过 4 小时切场，跨日切场', () => {
    const orders = [
      order('o1', '2026-01-01T10:00:00', 100, ''),
      order('o2', '2026-01-01T11:00:00', 200, ''),
      order('o3', '2026-01-01T16:00:00', 300, ''),
      order('o4', '2026-01-02T10:00:00', 400, '')
    ];
    const groups = groupOrdersBySession(orders);
    expect(groups.map((g) => g.map((o) => o.id))).toEqual([['o1', 'o2'], ['o3'], ['o4']]);
  });

  it('乱序输入按时间排序后分组', () => {
    const orders = [
      order('late', '2026-01-01T12:00:00', 200, ''),
      order('early', '2026-01-01T10:00:00', 100, '')
    ];
    expect(groupOrdersBySession(orders)[0].map((o) => o.id)).toEqual(['early', 'late']);
  });

  it('分组前后金额与单数不变', () => {
    const orders = [
      order('o1', '2026-01-01T10:00:00', 9000, ''),
      order('o2', '2026-01-01T11:00:00', 2000, ''),
      order('o3', '2026-01-01T18:00:00', 1000, ''),
      order('o4', '2026-01-02T10:00:00', 500, '')
    ];
    const lines = [
      line('l1', 'o1', 10, 1000, 9000),
      line('l2', 'o1', 5, 500, 0, true),
      line('l2b', 'o2', 2, 1000, 2000),
      line('l3', 'o3', 2, 500, 1000),
      line('l4', 'o4', 1, 500, 500)
    ];
    const batches = [batch('b1', 100, 100, '2026-01-01')];
    const fifo = fifoAllocate(batches, orders, lines);

    // 模拟迁移：给每组一个 sessionId，再逐场汇总
    const groups = groupOrdersBySession(orders);
    let revenue = 0;
    let count = 0;
    let cost = 0;
    groups.forEach((group, i) => {
      const sid = `mig-${i}`;
      const migrated = orders.map((o) =>
        group.some((g) => g.id === o.id) ? { ...o, sessionId: sid } : o
      );
      const rep = sessionReport(sid, migrated, lines, fifo);
      revenue += rep.revenueFen;
      count += rep.orderCount;
      cost += rep.costFen;
    });

    expect(count).toBe(orders.length);
    expect(revenue).toBe(9000 + 2000 + 1000 + 500);
    // l1 1000 + 赠品 500 + l2b 200 + l3 200 + l4 100
    expect(cost).toBe(2000);
  });
});

describe('场次合并决策', () => {
  const base: Session = {
    id: 's1',
    deviceId: 'd1',
    startedAt: '2026-01-01T10:00:00.000Z',
    status: 'open',
    openedBy: '我',
    patchedCount: 0,
    updatedAt: '2026-01-01T10:00:00.000Z'
  };

  it('closed 优先于 open', () => {
    const closed: Session = {
      ...base,
      status: 'closed',
      closedAt: '2026-01-01T20:00:00.000Z',
      updatedAt: '2026-01-01T20:00:00.000Z'
    };
    expect(mergeSessionPair(base, closed).status).toBe('closed');
    // 即使本地 updatedAt 更新，也不能把 closed 拉回 open
    const localNewer: Session = { ...base, updatedAt: '2026-01-02T00:00:00.000Z' };
    expect(mergeSessionPair(localNewer, closed).status).toBe('closed');
  });

  it('同状态取 updatedAt 新者', () => {
    const newer: Session = { ...base, updatedAt: '2026-01-01T23:00:00.000Z', note: '新' };
    expect(mergeSessionPair(base, newer).note).toBe('新');
    // 本地更新的记录不会被更旧的备份覆盖
    const older: Session = { ...base, updatedAt: '2025-12-31T00:00:00.000Z', note: '旧' };
    expect(mergeSessionPair(newer, older).note).toBe('新');
  });

  it('补记计数取 max，不累加', () => {
    const cur: Session = { ...base, patchedCount: 2 };
    const inc: Session = { ...base, patchedCount: 3, updatedAt: '2026-01-01T23:00:00.000Z' };
    expect(mergeSessionPair(cur, inc).patchedCount).toBe(3);
    // winner 是本地时也要保留更大的补记计数
    expect(mergeSessionPair(inc, cur).patchedCount).toBe(3);
  });
});