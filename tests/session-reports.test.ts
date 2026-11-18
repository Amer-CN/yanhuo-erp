import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { fifoAllocate, sessionReport, sessionReports } from '../src/db/calc';
import type { SaleLine, SalesOrder } from '../src/db/types';
import {
  DEVICE,
  T0,
  makeAdjustment,
  makeBatch,
  makeLine,
makeOrder,
  makeSession
} from './helpers';

/**
 * `sessionReports`（批量）必须与 `sessionReport`（逐场）**逐字段一致**：
 * 报表页整页改走批量后，任何口径漂移都会让「历史场次列表」和「本场汇总」
 * 显示同一场却给出两个数。这里覆盖作废单、赠品、超卖缺批次、跨场次混排。
 */
describe('sessionReports 批量汇总', () => {
  const batches = [
    // p1 只够卖 6 个：后面会故意超卖，触发兜底均价与 uncoveredQty
    makeBatch('b1', 'p1', 6, 500),
    makeBatch('b2', 'p2', 100, 300),
    makeBatch('b3', 'p3', 100, 800)
  ];
  const adjustments = [makeAdjustment('a1', 'p1', -1)];

  const sessions = [
    makeSession('s1', { status: 'closed', closedAt: T0 }),
    makeSession('s2', { status: 'closed', closedAt: T0 }),
    makeSession('s3', { status: 'open' })
  ];

  const orders: SalesOrder[] = [
    makeOrder('o1', 3000, 's1'),
    makeOrder('o2', 1500, 's1', { payMethod: 'wechat' }),
    makeOrder('o3', 900, 's1', { payMethod: 'alipay', voided: true }),
    makeOrder('o4', 2000, 's2'),
    makeOrder('o5', 0, 's2', { payMethod: 'wechat' }),
    makeOrder('o6', 1200, 's3', { payMethod: 'alipay' })
  ];

  const lines: SaleLine[] = [
    makeLine('l1', 'o1', 'p1', 4, 3000),
    makeLine('l2', 'o2', 'p2', 5, 1500, { discountFen: 200 }),
    // 作废单的明细不计入任何合计
    makeLine('l3', 'o3', 'p2', 3, 900),
    // 赠品：成本计入、让利不计
    makeLine('l4', 'o4', 'p3', 2, 2000, { gift: true, discountFen: 0 }),
    // p1 第二场再卖 4 个：只剩 2 个可扣，2 个走兜底均价 → uncoveredQty
    makeLine('l5', 'o6', 'p1', 4, 1200)
  ];

  const fifo = fifoAllocate(batches, orders, lines);
  const ids = sessions.map((s) => s.id);

  it('每个场次的每个字段都与逐场实现一致', () => {
    const batch = sessionReports(ids, orders, lines, fifo);
    for (const id of ids) {
      expect(batch.get(id)).toEqual(sessionReport(id, orders, lines, fifo));
    }
  });

  it('只返回传入的场次，且重复 id 不重复计数', () => {
    const batch = sessionReports(['s1', 's1', 'missing'], orders, lines, fifo);
    expect([...batch.keys()].sort()).toEqual(['missing', 's1']);
    expect(batch.get('s1')).toEqual(sessionReport('s1', orders, lines, fifo));
    expect(batch.get('missing')?.orderCount).toBe(0);
  });

  it('空入参返回空 Map', () => {
    expect(sessionReports([], orders, lines, fifo).size).toBe(0);
  });

  it('缺批次销量与毛利口径沿用逐场实现', () => {
    const s2 = sessionReports(['s2'], orders, lines, fifo).get('s2')!;
    expect(s2.uncoveredQty).toBe(0);
    expect(s2.giftQty).toBe(2);
    expect(s2.giftCostFen).toBe(1600);

    const s3 = sessionReports(['s3'], orders, lines, fifo).get('s3')!;
    // p1 只剩 2 个，另外 2 个按兜底均价（500/个）补
    expect(s3.uncoveredQty).toBe(2);
    expect(s3.costFen).toBe(2 * 500 + 2 * 500);
    expect(s3.grossFen).toBe(s3.revenueFen - s3.costFen);
  });

  it('库存口径不受影响（调整项只在 inventoryMap 里）', () => {
    // 这里只确认批量汇总没有意外把 adjustments 塞进成本
    const s1 = sessionReports(['s1'], orders, lines, fifo).get('s1')!;
    expect(s1.costFen).toBe(4 * 500 + 5 * 300);
    expect(adjustments.length).toBe(1);
    expect(DEVICE).toBeTruthy();
  });
});

