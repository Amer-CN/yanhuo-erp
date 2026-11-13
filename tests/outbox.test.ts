import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db/db';
import {
  clearOutbox,
  enqueue,
  enqueueAllLocal,
  enqueueInTx,
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
afterEach(() => vi.restoreAllMocks());

describe('outbox', () => {
  it('同毫秒每次入队均生成唯一 revision，主键仍去重', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const revisions: (string | undefined)[] = [];
    for (const op of ['upsert', 'upsert', 'delete', 'upsert'] as const) {
      await enqueue('order', 'o1', op);
      const row = await db.outbox.get('order:o1');
      revisions.push(row?.revision);
      expect(row).toMatchObject({ id: 'order:o1', queuedAt: 1000, op });
    }
    expect(revisions).toEqual(revisions.map(() => expect.any(String)));
    expect(new Set(revisions).size).toBe(4);
    expect(await pendingCount()).toBe(1);
  });

  it('批量和事务内入队也生成新 revision，queuedAt 保持批内序号排序', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    await enqueueMany([{ kind: 'order', recordId: 'o1' }, { kind: 'line', recordId: 'l1' }]);
    const initial = await db.outbox.orderBy('queuedAt').toArray();
    expect(initial.map((row) => row.id)).toEqual(['order:o1', 'line:l1']);
    expect(initial.map((row) => row.queuedAt)).toEqual([1000, 1001]);
    await db.transaction('rw', db.outbox, () => enqueueInTx([
      { kind: 'order', recordId: 'o1' }, { kind: 'line', recordId: 'l1' }
    ]));
    const replaced = await db.outbox.orderBy('queuedAt').toArray();
    const revisions = [...initial, ...replaced].map((row) => row.revision);
    expect(revisions).toEqual(revisions.map(() => expect.any(String)));
    expect(new Set(revisions).size).toBe(4);
    expect(replaced.map((row) => row.queuedAt)).toEqual([1000, 1001]);
  });

  it('单条 enqueue 本机专属 setting 是空操作，不向 Dexie put undefined', async () => {
    for (const key of ['deviceId', 'deviceName', 'operatorSelf', 'sync-unknown-kinds']) {
      await expect(enqueue('setting', key)).resolves.toBeUndefined();
    }
    expect(await pendingCount()).toBe(0);
  });

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