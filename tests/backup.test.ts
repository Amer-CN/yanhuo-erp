import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  backupDb,
  abandonSnapshot,
  createSnapshot,
  listSnapshots,
  markSnapshotCommitted,
  pruneSnapshots,
  restoreSnapshot,
  snapshotBeforeOpen
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

/** 手工造一个 v2 主库（没有 sessions 表），模拟老版本设备升级前的数据 */
function createV2Database(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('yanhuo-erp', 2);
    req.onupgradeneeded = () => {
      const idb = req.result;
      idb.createObjectStore('products', { keyPath: 'id' });
      idb.createObjectStore('batches', { keyPath: 'id' });
      idb.createObjectStore('orders', { keyPath: 'id' });
      idb.createObjectStore('lines', { keyPath: 'id' });
      idb.createObjectStore('adjustments', { keyPath: 'id' });
      idb.createObjectStore('settings', { keyPath: 'key' });
      idb.createObjectStore('outbox', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const idb = req.result;
      const tx = idb.transaction(['products', 'orders', 'settings'], 'readwrite');
      tx.objectStore('products').put(product('p-v2', '旧货'));
      tx.objectStore('orders').put(order('o-v2', 700));
      tx.objectStore('settings').put({ key: 'deviceId', value: 'dev-v2' });
      tx.oncomplete = () => {
        idb.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
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

  it('设备时间回拨时刚保存的恢复前安全快照不会被日期清理删掉', async () => {
    for (const day of ['2099-01-01', '2099-01-02', '2099-01-03']) {
      await backupDb.snapshots.add({ at: `${day}T10:00:00.000Z`, reason: 'manual',
        schemaVersion: db.verno, deviceId: 'dev-test', file: emptyFile() });
    }
    const safe = await createSnapshot('pre-recovery', emptyFile());
    expect(await backupDb.snapshots.get(safe.id!)).toBeTruthy();
    await pruneSnapshots();
    expect(await backupDb.snapshots.get(safe.id!)).toBeTruthy();
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

  it('prune retains the newest pre-merge snapshot for persistent undo', async () => {
    for (const day of ['2099-02-01', '2099-02-02', '2099-02-03', '2099-02-04']) {
      await backupDb.snapshots.add({ at: `${day}T10:00:00.000Z`, reason: 'manual',
        schemaVersion: db.verno, deviceId: 'dev-test', file: emptyFile() });
    }
    const safe = await createSnapshot('pre-merge', emptyFile());
    await pruneSnapshots();
    expect(await backupDb.snapshots.get(safe.id!)).toBeTruthy();
  });

  it('retains the newest pre-merge by save order even when the device clock moves backwards', async () => {
    for (const day of ['2099-03-01', '2099-03-02', '2099-03-03']) {
      await backupDb.snapshots.add({ at: `${day}T10:00:00.000Z`, reason: 'manual',
        schemaVersion: db.verno, deviceId: 'dev-test', file: emptyFile() });
    }
    const older = await backupDb.snapshots.add({ at: '2099-04-01T10:00:00.000Z', reason: 'pre-merge',
      schemaVersion: db.verno, deviceId: 'dev-test', file: emptyFile() });
    const newer = await backupDb.snapshots.add({ at: '2026-01-01T10:00:00.000Z', reason: 'pre-merge',
      schemaVersion: db.verno, deviceId: 'dev-test', file: emptyFile() });
    await pruneSnapshots();
    expect(await backupDb.snapshots.get(newer)).toBeTruthy();
    expect(newer).toBeGreaterThan(older);
  });

  it('can create a pre-merge snapshot without pruning the previous undo point', async () => {
    const previous = await createSnapshot('pre-merge', emptyFile());
    for (const day of ['2099-05-01', '2099-05-02', '2099-05-03']) {
      await backupDb.snapshots.add({ at: `${day}T10:00:00.000Z`, reason: 'manual',
        schemaVersion: db.verno, deviceId: 'dev-test', file: emptyFile() });
    }
    await createSnapshot('pre-merge', emptyFile(), false);
    expect(await backupDb.snapshots.get(previous.id!)).toBeTruthy();
  });

  it('prune retains the snapshot referenced by the local undo pointer', async () => {
    const pointed = await createSnapshot('pre-merge', emptyFile());
    await db.settings.put({ key: 'mergeUndoSnapshotId', value: String(pointed.id) });
    for (const day of ['2099-06-01', '2099-06-02', '2099-06-03']) {
      await backupDb.snapshots.add({ at: `${day}T10:00:00.000Z`, reason: 'manual',
        schemaVersion: db.verno, deviceId: 'dev-test', file: emptyFile() });
    }
    await createSnapshot('pre-merge', emptyFile(), false);
    await pruneSnapshots();
    expect(await backupDb.snapshots.get(pointed.id!)).toBeTruthy();
  });

  it('prune retains an actively reserved pending snapshot before the merge commits', async () => {
    const pending = await createSnapshot('pre-merge', emptyFile(), false);
    await pruneSnapshots();
    expect(await backupDb.snapshots.get(pending.id!)).toMatchObject({ pending: true });
  });

  it('prune removes a pending snapshot only after it is explicitly abandoned', async () => {
    const pending = await createSnapshot('pre-merge', emptyFile(), false);
    await abandonSnapshot(pending.id!, pending.reservationToken!);
    await pruneSnapshots();
    expect(await backupDb.snapshots.get(pending.id!)).toBeUndefined();
  });

  it('prune removes a pending snapshot after its reservation expires', async () => {
    const pending = await createSnapshot('pre-merge', emptyFile(), false);
    await backupDb.snapshots.update(pending.id!, { reservationExpiresAt: Date.now() - 1 });
    await pruneSnapshots();
    expect(await backupDb.snapshots.get(pending.id!)).toBeUndefined();
  });

  it('prune conservatively retains pending snapshots while the main database is closed', async () => {
    const pending = await createSnapshot('pre-merge', emptyFile(), false);
    await db.close();
    try {
      await pruneSnapshots();
      expect(await backupDb.snapshots.get(pending.id!)).toBeTruthy();
    } finally {
      await db.open();
    }
  });

  it('committing a reserved snapshot clears its pending state and survives pruning', async () => {
    const pending = await createSnapshot('pre-merge', emptyFile(), false);
    await markSnapshotCommitted(pending.id!, pending.reservationToken!);
    await pruneSnapshots();
    expect(await backupDb.snapshots.get(pending.id!)).toMatchObject({ pending: false });
  });

  it('rejects committing or abandoning a reservation owned by another tab', async () => {
    const pending = await createSnapshot('pre-merge', emptyFile(), false);
    await expect(markSnapshotCommitted(pending.id!, 'wrong-token')).rejects.toThrow(/预留|不属于/);
    await expect(abandonSnapshot(pending.id!, 'wrong-token')).rejects.toThrow(/预留|不属于/);
    expect(await backupDb.snapshots.get(pending.id!)).toMatchObject({ pending: true });
  });

  it('restoring a snapshot clears the local merge undo pointer atomically', async () => {
    await db.settings.put({ key: 'mergeUndoSnapshotId', value: '99' });
    const snapshot = await createSnapshot('manual');
    await db.settings.put({ key: 'mergeUndoSnapshotId', value: '100' });
    await restoreSnapshot(snapshot.id as number);
    expect(await db.settings.get('mergeUndoSnapshotId')).toBeUndefined();
  });

  it('v2 数据（无 sessions）：首次打开前生成 pre-migrate 快照', async () => {
    await db.close();
    await db.delete();
    await backupDb.snapshots.clear();
    await createV2Database();

    const before = await snapshotBeforeOpen();
    expect(before.created).toBe(false);
    expect(before.version).toBe(2);
    expect(before.snapshotId).toBeTypeOf('number');

    const pre = (await listSnapshots()).find((s) => s.reason === 'pre-migrate');
    expect(pre).toBeTruthy();
    expect(pre?.schemaVersion).toBe(2);
    expect(pre?.file.data.orders).toHaveLength(1);
    expect(pre?.file.data.orders[0].totalFen).toBe(700);
    expect(pre?.file.data.products).toHaveLength(1);
    expect(pre?.file.data.sessions).toEqual([]);

    // 恢复成 Dexie v3，避免影响后续清理
    await db.open();
  });
});