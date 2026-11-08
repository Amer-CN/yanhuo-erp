import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/db';
import { migrateSessions } from '../src/db/repo';
import { groupOrdersBySession } from '../src/db/sessionLogic';
import { SETTING_KEYS } from '../src/db/types';
import { makeLine, makeOrder, makeSession, resetDb } from './helpers';

const OLD_ORDERS = [
  { id: 'o1', at: '2026-11-01T02:00:00.000Z', total: 1000 },
  { id: 'o2', at: '2026-11-01T03:00:00.000Z', total: 2000 },
  { id: 'o3', at: '2026-11-01T10:00:00.000Z', total: 3000 },
  { id: 'o4', at: '2026-11-02T02:00:00.000Z', total: 4000 }
];

async function seedOldOrders(): Promise<void> {
  for (const o of OLD_ORDERS) {
    const order = makeOrder(o.id, o.total);
    delete order.sessionId;
    order.createdAt = o.at;
    order.deviceId = 'old-device';
    order.payMethod = o.id === 'o3' ? 'wechat' : 'cash';
    await db.orders.put(order);
    await db.lines.put(makeLine(`l-${o.id}`, o.id, 'p1', 1, o.total));
  }
}

beforeEach(resetDb);

describe('migrateSessions', () => {
  it('旧订单按「4 小时 / 跨自然日」切场，单数与金额不变', async () => {
    await seedOldOrders();

    // 同一天 02:00、03:00 一场；10:00 间隔 7h 新一场；次日 02:00 再新一场
    const groups = groupOrdersBySession((await db.orders.toArray()).filter((o) => !o.sessionId));
    expect(groups.map((g) => g.map((o) => o.id))).toEqual([['o1', 'o2'], ['o3'], ['o4']]);

    const beforeOrders = await db.orders.toArray();
    const beforeTotal = beforeOrders.reduce((s, o) => s + o.totalFen, 0);

    const created = await migrateSessions();
    expect(created).toBe(3);

    const afterOrders = await db.orders.toArray();
    expect(afterOrders).toHaveLength(beforeOrders.length);
    expect(afterOrders.reduce((s, o) => s + o.totalFen, 0)).toBe(beforeTotal);
    for (const o of afterOrders) expect(o.sessionId).toBeTruthy();

    const sessions = await db.sessions.toArray();
    expect(sessions).toHaveLength(3);
    for (const s of sessions) {
      expect(s.status).toBe('closed');
      expect(s.summary?.orderCount).toBeGreaterThan(0);
    }
    const revenueByOrder = (id: string) =>
      sessions.find((s) => afterOrders.find((o) => o.id === id)?.sessionId === s.id)?.summary
        ?.revenueFen;
    expect(revenueByOrder('o1')).toBe(3000);
    expect(revenueByOrder('o3')).toBe(3000);
    expect(revenueByOrder('o4')).toBe(4000);

    expect((await db.settings.get(SETTING_KEYS.sessionsMigrated))?.value).toBe('1');
  });

  it('重复迁移幂等：第二次返回 0，不新增场次、不改订单', async () => {
    await seedOldOrders();
    expect(await migrateSessions()).toBe(3);
    const sessionsBefore = await db.sessions.toArray();
    const ordersBefore = await db.orders.toArray();

    expect(await migrateSessions()).toBe(0);
    expect(await db.sessions.count()).toBe(sessionsBefore.length);
    expect(await db.orders.toArray()).toEqual(ordersBefore);
  });

  it('没有历史订单时只写 sessionsMigrated，不建空场次', async () => {
    expect(await migrateSessions()).toBe(0);
    expect(await db.sessions.count()).toBe(0);
    expect((await db.settings.get(SETTING_KEYS.sessionsMigrated))?.value).toBe('1');
  });

  it('已有 sessionId 的订单不会被迁移再切分', async () => {
    await db.sessions.put(makeSession('s-exist', { status: 'closed' }));
    await db.orders.put(makeOrder('o-existing', 500, 's-exist'));
    await db.settings.put({ key: SETTING_KEYS.sessionsMigrated, value: 'yes' });

    expect(await migrateSessions()).toBe(0);
    expect((await db.orders.get('o-existing'))?.sessionId).toBe('s-exist');
    expect(await db.sessions.count()).toBe(1);
  });
});