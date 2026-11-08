import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/db';
import {
  exportBackup,
  importMerge,
  parseBackup,
  replaceAll,
  type BackupFile
} from '../src/db/merge';
import { mergeSessionPair } from '../src/db/sessionLogic';
import { EMPTY_DATA } from '../src/db/types';
import {
  DEVICE,
  T0,
  makeBatch,
  makeLine,
  makeOrder,
  makeProduct,
  makeSession,
  resetDb
} from './helpers';

function makeBackup(data: Partial<BackupFile['data']> = {}, extra: Partial<BackupFile> = {}): BackupFile {
  return {
    app: 'yanhuo-erp',
    version: 2,
    exportedAt: T0,
    deviceId: 'other-device',
    data: { ...structuredClone(EMPTY_DATA), ...data },
    ...extra
  };
}

beforeEach(resetDb);

describe('importMerge', () => {
  it('流水只增：同 id 订单/明细/批次不覆盖，新 id 才追加', async () => {
    await db.orders.put(makeOrder('o1', 1000));
    await db.lines.put(makeLine('l1', 'o1', 'p1', 1, 1000));
    await db.batches.put(makeBatch('b1', 'p1', 5, 100));

    const result = await importMerge(
      makeBackup({
        orders: [makeOrder('o1', 9999), makeOrder('o2', 500)],
        lines: [makeLine('l1', 'o1', 'p1', 99, 9999), makeLine('l2', 'o2', 'p1', 1, 500)],
        batches: [makeBatch('b1', 'p1', 999, 9), makeBatch('b2', 'p1', 2, 200)]
      })
    );

    expect(result.ordersAdded).toBe(1);
    expect(result.linesAdded).toBe(1);
    expect(result.batchesAdded).toBe(1);
    expect((await db.orders.get('o1'))?.totalFen).toBe(1000);
    expect((await db.lines.get('l1'))?.qtyBase).toBe(1);
    expect((await db.batches.get('b1'))?.qtyBase).toBe(5);
    expect(await db.orders.get('o2')).toBeTruthy();
    expect(await db.lines.get('l2')).toBeTruthy();
    expect(await db.batches.get('b2')).toBeTruthy();
  });

  it('商品按 updatedAt 新者胜；相同或更旧不写', async () => {
    await db.products.bulkPut([
      makeProduct('p1', { updatedAt: '2026-11-01T00:00:00.000Z' }),
      makeProduct('p3', { updatedAt: '2026-12-01T00:00:00.000Z' }),
      makeProduct('p4', { updatedAt: '2026-11-05T00:00:00.000Z' })
    ]);

    const result = await importMerge(
      makeBackup({
        products: [
          makeProduct('p1', { name: '新名字', updatedAt: '2026-11-02T00:00:00.000Z' }),
          makeProduct('p2', { updatedAt: '2026-11-02T00:00:00.000Z' }),
          makeProduct('p3', { name: '更旧', updatedAt: '2026-11-01T00:00:00.000Z' }),
          makeProduct('p4', { name: '一样新', updatedAt: '2026-11-05T00:00:00.000Z' })
        ]
      })
    );

    expect(result.productsAdded).toBe(1);
    expect(result.productsUpdated).toBe(1);
    expect(result.productsKept).toBe(2);
    expect((await db.products.get('p1'))?.name).toBe('新名字');
    expect((await db.products.get('p3'))?.name).not.toBe('更旧');
    expect((await db.products.get('p4'))?.name).not.toBe('一样新');
  });

  it('设置导入跳过本机身份与操作人，其余覆盖', async () => {
    await db.settings.put({ key: 'deviceId', value: 'local' });
    await db.settings.put({ key: 'operatorA', value: '本机' });

    const result = await importMerge(
      makeBackup({
        settings: [
          { key: 'deviceId', value: 'other' },
          { key: 'operatorA', value: '对方' },
          { key: 'expiryWarnDays', value: '7' }
        ]
      })
    );

    expect(result.settingsImported).toBe(1);
    expect((await db.settings.get('deviceId'))?.value).toBe('local');
    expect((await db.settings.get('operatorA'))?.value).toBe('本机');
    expect((await db.settings.get('expiryWarnDays'))?.value).toBe('7');
  });
});

describe('场次合并', () => {
  it('mergeSessionPair：closed 优先，patchedCount 取 max', () => {
    const open = makeSession('s1', {
      status: 'open',
      updatedAt: '2026-11-02T00:00:00.000Z',
      patchedCount: 1
    });
    const closed = makeSession('s1', {
      status: 'closed',
      updatedAt: '2026-11-01T00:00:00.000Z',
      patchedCount: 4
    });
    const merged = mergeSessionPair(open, closed);
    expect(merged.status).toBe('closed');
    expect(merged.patchedCount).toBe(4);

    const newer = mergeSessionPair(
      makeSession('s1', { status: 'closed', updatedAt: '2026-11-02T00:00:00.000Z', patchedCount: 2 }),
      makeSession('s1', { status: 'closed', updatedAt: '2026-11-01T00:00:00.000Z', patchedCount: 5 })
    );
    expect(newer.updatedAt).toBe('2026-11-02T00:00:00.000Z');
    expect(newer.patchedCount).toBe(5);
  });

  it('importMerge 走 mergeSessionPair：本地 open 不被远端 open 覆盖为 closed 之外的状态', async () => {
    await db.sessions.put(
      makeSession('s1', { status: 'open', patchedCount: 1, updatedAt: '2026-11-02T00:00:00.000Z' })
    );

    const result = await importMerge(
      makeBackup({
        sessions: [
          makeSession('s1', {
            status: 'closed',
            patchedCount: 4,
            updatedAt: '2026-11-01T00:00:00.000Z',
            closedAt: '2026-11-01T12:00:00.000Z'
          })
        ]
      })
    );

    expect(result.sessionsUpdated).toBe(1);
    const session = await db.sessions.get('s1');
    expect(session?.status).toBe('closed');
    expect(session?.patchedCount).toBe(4);
  });
});

describe('replaceAll / exportBackup / parseBackup', () => {
  it('replaceAll 整库替换后可读回，旧数据被清掉', async () => {
    await db.products.put(makeProduct('old'));
    await db.orders.put(makeOrder('old-order', 1));
    await db.settings.put({ key: 'k', value: 'old' });

    const file = makeBackup({
      products: [makeProduct('new')],
      orders: [makeOrder('new-order', 800, 's-new')],
      lines: [makeLine('new-line', 'new-order', 'new', 1, 800)],
      sessions: [makeSession('s-new')]
    });
    await replaceAll(file);

    expect(await db.products.count()).toBe(1);
    expect((await db.products.toArray())[0].id).toBe('new');
    expect(await db.orders.get('old-order')).toBeUndefined();
    expect((await db.orders.get('new-order'))?.totalFen).toBe(800);
    expect(await db.lines.count()).toBe(1);
    expect(await db.sessions.count()).toBe(1);
  });

  it('exportBackup 导出当前库；parseBackup 可回读且拒绝非法文件', async () => {
    await db.products.put(makeProduct('p1'));
    await db.orders.put(makeOrder('o1', 1000));

    const file = await exportBackup(DEVICE);
    expect(file.app).toBe('yanhuo-erp');
    expect(file.version).toBe(2);
    expect(file.deviceId).toBe(DEVICE);
    expect(file.data.products).toHaveLength(1);
    expect(file.data.orders).toHaveLength(1);

    const parsed = parseBackup(JSON.stringify(file));
    expect(parsed.data.orders[0].id).toBe('o1');

    const minimal = parseBackup(
      JSON.stringify({ app: 'yanhuo-erp', data: { products: [], orders: [] } })
    );
    expect(minimal.data.sessions).toEqual([]);
    expect(minimal.version).toBe(1);

    expect(() => parseBackup('{}')).toThrow('不是本工具导出的备份文件');
    expect(() => parseBackup(JSON.stringify({ app: 'yanhuo-erp', data: {} }))).toThrow(
      '备份文件结构不完整'
    );
  });
});