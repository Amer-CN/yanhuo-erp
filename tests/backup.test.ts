import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  backupDb,
  createSnapshot,
  listSnapshots,
  pruneSnapshots,
  restoreSnapshot
} from '../src/db/backup';
import { db } from '../src/db/db';
import type { BackupFile } from '../src/db/merge';
import { EMPTY_DATA, type Product, type SalesOrder } from '../src/db/types';

const T = '2026-11-08T10:00:00.000Z';

function product(id: string, name: string): Product {
  return {
    id,
    name,
    category: '炮',
    unitBase: '个',
    boxQty: 10,
    priceList: 100,
    negotiable: true,
    archived: false,
    sortOrder: 0,
    createdAt: T,
    updatedAt: T
  };
}

function order(id: string, totalFen: number): SalesOrder {
  return {
    id,
    deviceId: 'dev-test',
    operator: '我',
    createdAt: T,
    payMethod: 'cash',
    totalFen
  };
}

function emptyFile(): BackupFile {
  return {
    app: 'yanhuo-erp',
    version: 2,
    exportedAt: T,
    deviceId: 'dev-test',
    data: structuredClone(EMPTY_DATA)
  };
}

beforeEach(async () => {
  await Promise.all([
    db.products.clear(),
    db.batches.clear(),
    db.orders.clear(),
    db.lines.clear(),
    db.adjustments.clear(),
    db.sessions.clear(),
    db.settings.clear(),
    db.outbox.clear()
  ]);
  await backupDb.snapshots.clear();
});

describe('本地备份', () => {
  it('快照 → 清库 → 恢复后订单数/销售额/商品数一致', async () => {
    await db.products.bulkPut([product('p1', '大地红'), product('p2', '二踢脚')]);
    await db.orders.bulkPut([order('o1', 1000), order('o2', 2000)]);

    const snap = await createSnapshot('manual');
    expect(snap.id).toBeTypeOf('number');
    expect(snap.schemaVersion).toBe(db.verno);
    expect(snap.file.data.orders).toHaveLength(2);

    await Promise.all([
      db.products.clear(),
      db.orders.clear(),
      db.lines.clear(),
      db.settings.clear()
    ]);
    expect(await db.orders.count()).toBe(0);
    expect(await db.products.count()).toBe(0);

    await restoreSnapshot(snap.id as number);

    const restoredOrders = await db.orders.toArray();
    expect(restoredOrders).toHaveLength(2);
    expect(restoredOrders.reduce((sum, o) => sum + o.totalFen, 0)).toBe(3000);
    expect(await db.products.count()).toBe(2);
  });

  it('快照记录 reason/deviceId，列表按时间倒序', async () => {
    const first = await createSnapshot('close');
    const second = await createSnapshot('manual');
    expect(first.reason).toBe('close');
    expect(second.reason).toBe('manual');
    expect(second.deviceId).toBe(first.deviceId);

    const list = await listSnapshots();
    expect(list.length).toBeGreaterThanOrEqual(1);
    // 同一天只保留最新一份，倒序列表第一条必须是刚写入的
    expect(list[0].id).toBe(second.id);
  });

  it('prune 只保留最近 3 个日期 + 1 份 pre-migrate（≤4 条）', async () => {
    const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'];
    for (const day of days) {
      await backupDb.snapshots.add({
        at: `${day}T10:00:00.000Z`,
        reason: 'manual',
        schemaVersion: db.verno,
        deviceId: 'dev-test',
        file: emptyFile()
      });
    }
    await backupDb.snapshots.add({
      at: '2026-10-01T10:00:00.000Z',
      reason: 'pre-migrate',
      schemaVersion: db.verno,
      deviceId: 'dev-test',
      file: emptyFile()
    });

    const removed = await pruneSnapshots();
    const left = await listSnapshots();
    expect(removed).toBe(2);
    expect(left).toHaveLength(4);
    expect(left.map((row) => row.at.slice(0, 10)).sort()).toEqual([
      '2026-10-01',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05'
    ]);
  });
});