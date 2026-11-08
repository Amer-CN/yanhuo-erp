import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/db';
import {
  clearOutbox,
  enqueue,
  enqueueAllLocal,
  enqueueMany,
  pendingCount
} from '../src/db/outbox';
import {
  makeAdjustment,
  makeBatch,
  makeLine,
  makeOrder,
  makeProduct,
  makeSession,
  resetDb
} from './helpers';

beforeEach(resetDb);

describe('outbox', () => {
  it('同 kind:recordId 重复入队只留 1 条，op 以最后一次为准', async () => {
    await enqueue('order', 'o1');
    await enqueue('order', 'o1', 'delete');
    expect(await pendingCount()).toBe(1);

    const row = await db.outbox.get('order:o1');
    expect(row).toMatchObject({ kind: 'order', recordId: 'o1', op: 'delete' });
  });

  it('enqueueMany 批量入队并去重', async () => {
    await enqueueMany([
      { kind: 'line', recordId: 'l1' },
      { kind: 'line', recordId: 'l1', op: 'delete' },
      { kind: 'line', recordId: 'l2' }
    ]);
    expect(await pendingCount()).toBe(2);
    expect((await db.outbox.get('line:l1'))?.op).toBe('delete');
    expect((await db.outbox.get('line:l2'))?.op).toBe('upsert');
  });

  it('enqueueAllLocal 覆盖全部 7 张表（含 settings）', async () => {
    await db.products.put(makeProduct('p1'));
    await db.batches.put(makeBatch('b1', 'p1', 5, 100));
    await db.orders.put(makeOrder('o1', 1000, 's1'));
    await db.lines.put(makeLine('l1', 'o1', 'p1', 1, 1000));
    await db.adjustments.put(makeAdjustment('a1', 'p1', -1));
    await db.sessions.put(makeSession('s1'));
    await db.settings.put({ key: 'operatorA', value: '我' });

    await enqueueAllLocal();

    expect(await pendingCount()).toBe(7);
    expect(await db.outbox.get('product:p1')).toBeTruthy();
    expect(await db.outbox.get('batch:b1')).toBeTruthy();
    expect(await db.outbox.get('order:o1')).toBeTruthy();
    expect(await db.outbox.get('line:l1')).toBeTruthy();
    expect(await db.outbox.get('adjustment:a1')).toBeTruthy();
    expect(await db.outbox.get('session:s1')).toBeTruthy();
    expect(await db.outbox.get('setting:operatorA')).toBeTruthy();
  });

  it('clearOutbox 清空', async () => {
    await enqueue('order', 'o1');
    await enqueue('line', 'l1');
    expect(await pendingCount()).toBe(2);
    await clearOutbox();
    expect(await pendingCount()).toBe(0);
  });
});