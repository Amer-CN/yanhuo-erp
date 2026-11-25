// B05：真实 fake-indexeddb；恢复与撤销合并都不能访问远端。
import Dexie, { type Transaction, type WhereClause } from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDB, db } from '../src/db/db';
import { clearLocalSafely, completeRecoveryCleanup, RECOVERY_PENDING_KEY, restoreLocalBackup } from '../src/db/dataRecovery';
import { backupDb, createSnapshot, restoreSnapshot } from '../src/db/backup';
import { importMerge, parseBackup, replaceAll, type BackupFile } from '../src/db/merge';
import { UNKNOWN_KINDS_KEY } from '../src/db/outbox';
import { updateRecord, createAdjustment, updateProduct, voidOrder, restoreOrder, deleteRecord, type RecordInput } from '../src/db/repo';
import {
  SyncCoordinator, SyncLeaseLostError, SyncMaintenanceError,
  __setSyncControlForTest, captureWriteGeneration, pauseSync, readSyncControl, runMaintenance, runSyncExclusive
} from '../src/db/syncControl';
import type { SyncControlRow, SyncLease } from '../src/db/syncTypes';
import { EMPTY_DATA, type SaleLine } from '../src/db/types';
import { seedIfEmpty } from '../src/db/seed';
import { DEVICE, T0, makeAdjustment, makeBatch, makeLine, makeOrder, makeProduct, makeSession, resetDb } from './helpers';

const CLEANUP_KEYS = [
  'yh-sync-last-pull', 'yh-sync-last-pull-id', 'yh-sync-cleared-at', 'yh-sync-last-replay',
  'yh-sync-last-replay-cursor', 'yh-sync-parent-lookup-after', 'yh-sync-initial-pending',
  'yh-sync-last-sync', 'yh-sync-known-ids', 'yh-sync-warn', 'yh-sync-error'
];
const LOCAL_IDENTITY = ['deviceId', 'deviceName', 'operatorA', 'operatorB', 'operatorSelf'];
let store: Map<string, string>;
let fetchStub: ReturnType<typeof vi.fn>;
const connections: AppDB[] = [];

function file(data: Partial<BackupFile['data']> = {}): BackupFile {
  return { app: 'yanhuo-erp', version: 2, exportedAt: T0, deviceId: 'other-device',
    data: { ...structuredClone(EMPTY_DATA), ...data } };
}
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function secondConnection() {
  const other = new AppDB();
  connections.push(other);
  await other.open();
  return { db: other, control: new SyncCoordinator(other, other.syncMeta) };
}
async function seedOldState() {
  await db.products.put(makeProduct('old-product'));
  await db.orders.put(makeOrder('old-order', 100));
  await db.lines.put(makeLine('old-line', 'old-order', 'old-product', 1, 100));
  await db.sessions.put(makeSession('old-session'));
  await db.batches.put(makeBatch('old-batch', 'old-product', 2, 10));
  await db.adjustments.put(makeAdjustment('old-adjustment', 'old-product', -1));
  await db.settings.bulkPut([
    ...LOCAL_IDENTITY.map((key) => ({ key, value: key === 'deviceId' ? DEVICE : `local-${key}` })),
    { key: UNKNOWN_KINDS_KEY, value: '["stale"]' }, { key: 'old-setting', value: 'old' }
  ]);
  await db.outbox.put({ id: 'order:old-order', kind: 'order', recordId: 'old-order', op: 'delete', queuedAt: 1 });
  await db.conflicts.add({ at: T0, kind: 'order', recordId: 'old-order', local: '{}', remote: '{}' });
  await db.remotePendingLines.put({ id: 'pending-line', orderId: 'missing-order', receivedAt: 1,
    row: { id: 'line:pending-line', record_id: 'pending-line', kind: 'line', data: {}, updated_at: 1, deleted: false } });
  await db.remoteOrderUndo.put({ orderId: 'old-order', capturedAt: 1, beforeOrder: makeOrder('old-order', 50),
    beforeLines: [], beforeFingerprint: 'before', beforeComplete: true, remoteVersionKey: 'v1',
    afterFingerprint: 'after', canUndo: true });
}
async function localState() {
  return Promise.all([
    db.products.toArray(), db.batches.toArray(), db.orders.toArray(), db.lines.toArray(),
    db.adjustments.toArray(), db.sessions.toArray(), db.settings.orderBy('key').toArray(),
    db.outbox.toArray(), db.conflicts.toArray(), db.remotePendingLines.toArray(), db.remoteOrderUndo.toArray()
  ]);
}

beforeEach(async () => {
  __setSyncControlForTest(undefined);
  await db.open();
  await resetDb();
  await db.syncMeta.clear();
  await backupDb.snapshots.clear();
  store = new Map([
    ['yh-sync-disabled', '1'], ['yh-sync-url', 'https://unused.invalid'],
    ['yh-sync-anon', 'local-test-key'], ['yh-sync-ledger', 'local-test-ledger'],
    ['unrelated', 'keep'], ...CLEANUP_KEYS.map((key) => [key, 'stale'] as [string, string])
  ]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); }
  });
  fetchStub = vi.fn(() => { throw new Error('data-recovery test must never use network'); });
  vi.stubGlobal('fetch', fetchStub);
});
afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close();
  expect(fetchStub).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __setSyncControlForTest(undefined);
});

describe('recovery/write-generation race', () => {
  it('allows a fenced local write to commit across an ordinary sync pause', async () => {
    await db.products.put(makeProduct('paused-product'));
    const generation = await captureWriteGeneration();
    await pauseSync('user');

    await updateProduct('paused-product', { priceList: 2500 }, generation);

    expect((await db.products.get('paused-product'))?.priceList).toBe(2500);
    expect(await db.outbox.get('product:paused-product')).toMatchObject({ op: 'upsert' });
    expect(await readSyncControl()).toMatchObject({ paused: true, maintenance: false });
  });

  it('rejects stale product and order commands when recovery removed their targets', async () => {
    await db.products.put(makeProduct('stale-product'));
    await db.orders.put(makeOrder('stale-order', 100));
    const generation = await captureWriteGeneration();
    await restoreLocalBackup(file());

    await expect(updateProduct('stale-product', { priceList: 200 }, generation))
      .rejects.toMatchObject({ code: 'SYNC_GENERATION_MISMATCH' });
    await expect(voidOrder('stale-order', generation))
      .rejects.toMatchObject({ code: 'SYNC_GENERATION_MISMATCH' });
    await expect(restoreOrder('stale-order', generation))
      .rejects.toMatchObject({ code: 'SYNC_GENERATION_MISMATCH' });
    await expect(deleteRecord('stale-order', generation))
      .rejects.toMatchObject({ code: 'SYNC_GENERATION_MISMATCH' });
  });

  it('continues accepting new offline writes after recovery leaves sync persistently paused', async () => {
    await restoreLocalBackup(file());
    const adjustment = await createAdjustment({ productId: 'restored-product', qtyBase: 2, type: 'correction' }, DEVICE);
    expect(await readSyncControl()).toMatchObject({ paused: true, maintenance: false });
    expect(await db.adjustments.get(adjustment.id)).toMatchObject({ qtyBase: 2 });
    expect(await db.outbox.get(`adjustment:${adjustment.id}`)).toMatchObject({ op: 'upsert' });
  });

  it('serializes recovery behind an already fenced business write and snapshots the committed write', async () => {
    const entered = gate();
    const release = gate();
    const originalTransaction = db.transaction.bind(db);
    let held = false;
    vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) => {
      const [mode, tables, scope] = args;
      if (!held && mode === 'rw' && Array.isArray(tables) && tables.includes(db.adjustments)) {
        held = true;
        return Reflect.apply(originalTransaction, db, [mode, tables, async () => {
          entered.resolve();
          await Dexie.waitFor(release.promise);
          return (scope as () => Promise<unknown>)();
        }]);
      }
      return Reflect.apply(originalTransaction, db, args);
    }) as typeof db.transaction);

    const writing = createAdjustment({ productId: 'committed-before-recovery', qtyBase: 3, type: 'correction' }, DEVICE);
    void writing.catch(() => {});
    try {
      await entered.promise;
      const restoring = restoreLocalBackup(file());
      void restoring.catch(() => {});
      release.resolve();
      const adjustment = await writing;
      const result = await restoring;
      expect(result.snapshot.file.data.adjustments).toContainEqual(adjustment);
      expect(await db.adjustments.count()).toBe(0);
    } finally {
      release.resolve();
    }
  });

  it('checks generation inside the commit transaction even when recovery starts after the preflight check', async () => {
    const entered = gate();
    const release = gate();
    const originalTransaction = db.transaction.bind(db);
    let held = false;
    vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) => {
      const [mode, tables] = args;
      if (!held && mode === 'rw' && Array.isArray(tables) && tables.length === 3 && tables.includes(db.adjustments)) {
        held = true;
        entered.resolve();
        return release.promise.then(() => Reflect.apply(originalTransaction, db, args));
      }
      return Reflect.apply(originalTransaction, db, args);
    }) as typeof db.transaction);
    const writing = createAdjustment({ productId: 'old-product', qtyBase: 2, type: 'correction' }, DEVICE);
    void writing.catch(() => {});
    try {
      await entered.promise;
      await restoreLocalBackup(file());
      release.resolve();
      await expect(writing).rejects.toMatchObject({ code: 'SYNC_GENERATION_MISMATCH' });
    } finally { release.resolve(); }
    expect(await db.adjustments.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it('rejects an order edit that read the old ledger before recovery and reaches commit afterwards', async () => {
    const session = makeSession('session-stale');
    const order = makeOrder('order-stale', 100, session.id);
    await db.sessions.put(session);
    await db.orders.put(order);
    await db.lines.put(makeLine('line-stale', order.id, 'product-stale', 1, 100));

    const readComplete = gate();
    const releaseUpdate = gate();
    let paused = false;
    const originalWhere = db.lines.where.bind(db.lines) as (index: string) => WhereClause<SaleLine, string>;
    vi.spyOn(db.lines, 'where').mockImplementation(((index: string) => {
      const query = originalWhere(index);
      if (index !== 'orderId') return query;
      const originalEquals = query.equals.bind(query);
      vi.spyOn(query, 'equals').mockImplementation((value) => {
        const collection = originalEquals(value);
        const originalToArray = collection.toArray.bind(collection);
        vi.spyOn(collection, 'toArray').mockImplementation(() => Dexie.Promise.resolve(originalToArray()).then(async (rows) => {
          if (!paused) {
            paused = true;
            readComplete.resolve();
            await releaseUpdate.promise;
          }
          return rows;
        }));
        return collection;
      });
      return query;
    }) as typeof db.lines.where);

    const input: RecordInput = {
      deviceId: DEVICE,
      operator: '我',
      payMethod: 'cash',
      lines: [{
        productId: 'product-stale', qtyBase: 2, unit: 'base', qty: 2,
        listUnitPriceFen: 100, unitPriceFen: 100, amountFen: 200
      }]
    };
    const update = updateRecord(order.id, input);
    void update.catch(() => {});
    try {
      await readComplete.promise;
      await restoreLocalBackup(file());
      releaseUpdate.resolve();
      await expect(update).rejects.toMatchObject({ code: 'SYNC_GENERATION_MISMATCH' });
    } finally {
      releaseUpdate.resolve();
    }

    expect(await db.orders.get(order.id)).toBeUndefined();
    expect(await db.lines.where('orderId').equals(order.id).count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });
});


describe('local recovery boundary', () => {
  it('replaceAll clears the stale outbox, pending lines, conflicts and remote undo with business replacement', async () => {
    await seedOldState();
    await replaceAll(file({ products: [makeProduct('restored')], settings: [{ key: UNKNOWN_KINDS_KEY, value: '["foreign"]' }] }));
    expect(await db.outbox.count()).toBe(0);
    expect(await db.remotePendingLines.count()).toBe(0);
    expect(await db.conflicts.count()).toBe(0);
    expect(await db.remoteOrderUndo.count()).toBe(0);
    expect((await db.products.toArray()).map((row) => row.id)).toEqual(['restored']);
    expect(await db.settings.get(UNKNOWN_KINDS_KEY)).toBeUndefined();
  });

  it('replaceAll persists a new paused generation and preserves all five local identity keys', async () => {
    await seedOldState();
    const before = await readSyncControl();
    await replaceAll(file({ settings: LOCAL_IDENTITY.map((key) => ({ key, value: `foreign-${key}` })) }));
    const other = await secondConnection();
    expect(await other.control.read()).toMatchObject({ generation: before.generation + 1, paused: true, maintenance: false });
    for (const key of LOCAL_IDENTITY) {
      expect((await db.settings.get(key))?.value).toBe(key === 'deviceId' ? DEVICE : `local-${key}`);
    }
    for (const key of CLEANUP_KEYS) expect(store.has(key), key).toBe(false);
    expect(store.get('yh-sync-disabled')).toBe('1');
    expect(store.get('yh-sync-url')).toBe('https://unused.invalid');
    expect(store.get('yh-sync-anon')).toBe('local-test-key');
    expect(store.get('yh-sync-ledger')).toBe('local-test-ledger');
    expect(store.get('unrelated')).toBe('keep');
  });

  it('a business write failure rolls back every main-store mutation while the control plane stays paused', async () => {
    await seedOldState();
    const before = await localState();
    const failure = new Error('restore write failed');
    const hook = () => { throw failure; };
    db.lines.hook('creating', hook);
    try {
      await expect(replaceAll(file({ products: [makeProduct('new-product')],
        lines: [makeLine('new-line', 'new-order', 'new-product', 1, 10)] }))).rejects.toThrow('restore write failed');
    } finally { db.lines.hook('creating').unsubscribe(hook); }
    expect(await localState()).toEqual(before);
    expect(await readSyncControl()).toMatchObject({ generation: 1, paused: true, maintenance: false });
    expect(store.get('yh-sync-last-pull')).toBe('stale');
  });

  it('snapshot failure prevents replacement and leaves the old main data intact', async () => {
    await seedOldState();
    const before = await localState();
    vi.spyOn(backupDb.snapshots, 'add').mockRejectedValueOnce(new Error('snapshot quota failed'));
    await expect(replaceAll(file({ products: [makeProduct('new-product')] }))).rejects.toThrow('snapshot quota failed');
    expect(await localState()).toEqual(before);
    expect(await readSyncControl()).toMatchObject({ generation: 1, paused: true, maintenance: false });
  });

  it('blocks startup seed writes while recovery maintenance is active', async () => {
    await expect(runMaintenance('seed-test', () => seedIfEmpty())).rejects.toBeInstanceOf(SyncMaintenanceError);
    expect(await db.products.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it('creates the safety snapshot during maintenance and blocks a business writer on another connection', async () => {
    await seedOldState();
    const other = await secondConnection();
    const entered = gate();
    const release = gate();
    const realAdd = backupDb.snapshots.add.bind(backupDb.snapshots);
    vi.spyOn(backupDb.snapshots, 'add').mockImplementationOnce((row) => Dexie.Promise.resolve().then(async () => {
      expect(Dexie.currentTransaction).toBeFalsy();
      expect(await other.control.read()).toMatchObject({ paused: true, maintenance: true });
      entered.resolve();
      await release.promise;
      return realAdd(row);
    }));
    const restoring = replaceAll(file({ products: [makeProduct('restored')] }));
    void restoring.catch(() => {});
    try {
      await entered.promise;
      await expect(other.db.transaction('rw', [other.db.products, other.db.syncMeta], async () => {
        await other.control.assertWritable();
        await other.db.products.put(makeProduct('parallel-write'));
      })).rejects.toBeInstanceOf(SyncMaintenanceError);
      expect(await db.products.get('parallel-write')).toBeUndefined();
    } finally { release.resolve(); }
    await restoring;
  });

  it('returns the pre-replacement snapshot and a persistent paused generation without touching protocol metadata', async () => {
    await seedOldState();
    const metadata = db.table<{ key: string; scope: string; clearEpoch: number }, string>('syncMeta');
    await metadata.put({ key: 'sync-binding', scope: 'local-ledger', clearEpoch: 7 });
    const controlReads: Transaction[] = [];
    const hook = (row: SyncControlRow) => {
      if (row?.key === 'state' && row.maintenance && Dexie.currentTransaction?.storeNames.includes('products')) {
        controlReads.push(Dexie.currentTransaction);
      }
      return row;
    };
    db.syncMeta.hook('reading', hook);
    let result;
    try { result = await restoreLocalBackup(file({ products: [makeProduct('restored')] }), 'undo-merge'); }
    finally { db.syncMeta.hook('reading').unsubscribe(hook); }
    expect(result.paused).toBe(true);
    expect(result.generation).toBe(1);
    expect(result.snapshot.reason).toBe('pre-recovery');
    expect(result.snapshot.file.data.products.map((row) => row.id)).toEqual(['old-product']);
    expect((await backupDb.snapshots.get(result.snapshot.id!))?.file).toEqual(result.snapshot.file);
    expect(await metadata.get('sync-binding')).toEqual({ key: 'sync-binding', scope: 'local-ledger', clearEpoch: 7 });
    const replacementReads = controlReads.filter((tx) => tx.mode === 'readwrite');
    expect(replacementReads.length).toBeGreaterThanOrEqual(2);
    expect(replacementReads.every((tx) => [
      'products', 'batches', 'orders', 'lines', 'adjustments', 'sessions', 'settings',
      'outbox', 'conflicts', 'remotePendingLines', 'remoteOrderUndo', 'syncMeta'
    ].every((name) => tx.storeNames.includes(name)))).toBe(true);
    db.close();
    await db.open();
    expect(await readSyncControl()).toMatchObject({ generation: result.generation, paused: true,
      maintenance: false, reason: 'undo-merge' });
  });

  it('invalidates an already-running sync lease before taking the safety snapshot', async () => {
    const entered = gate<SyncLease>();
    const release = gate();
    const running = runSyncExclusive(async (lease) => { entered.resolve(lease); await release.promise; });
    void running.catch(() => {});
    const previousLease = await entered.promise;
    const other = await secondConnection();
    try {
      await restoreLocalBackup(file());
      expect(previousLease.signal.aborted).toBe(true);
      await expect(other.control.assertCurrent(previousLease)).rejects.toBeInstanceOf(SyncLeaseLostError);
    } finally { release.resolve(); await running; }
  });

  it('keeps the marker after localStorage cleanup fails and completes it after reopening', async () => {
    await seedOldState();
    const failure = new Error('localStorage unavailable');
    vi.spyOn(localStorage, 'removeItem').mockImplementationOnce(() => { throw failure; });
    await expect(restoreLocalBackup(file({ products: [makeProduct('restored')] }))).rejects.toThrow('localStorage unavailable');
    expect(await db.products.get('old-product')).toBeUndefined();
    expect(await db.products.get('restored')).toBeTruthy();
    const markers = db.table<{ key: string; generation: number }, string>('syncMeta');
    expect(await markers.get(RECOVERY_PENDING_KEY)).toMatchObject({ generation: 1 });
    expect(await readSyncControl()).toMatchObject({ generation: 1, paused: true, maintenance: false });
    db.close();
    await db.open();
    await completeRecoveryCleanup();
    expect(await markers.get(RECOVERY_PENDING_KEY)).toBeUndefined();
    for (const key of CLEANUP_KEYS) expect(store.has(key), key).toBe(false);
    expect(store.get('yh-sync-disabled')).toBe('1');
    await completeRecoveryCleanup();
  });

  it('a recovery-marker write failure rolls the replacement and all cleanup tables back', async () => {
    await seedOldState();
    const before = await localState();
    const meta = db.table<{ key: string }, string>('syncMeta');
    const hook = (_key: string, row: { key: string }) => {
      if (row.key === RECOVERY_PENDING_KEY) throw new Error('marker failed');
    };
    meta.hook('creating', hook);
    try { await expect(restoreLocalBackup(file())).rejects.toThrow('marker failed'); }
    finally { meta.hook('creating').unsubscribe(hook); }
    expect(await localState()).toEqual(before);
    expect(await meta.get(RECOVERY_PENDING_KEY)).toBeUndefined();
    expect(await readSyncControl()).toMatchObject({ generation: 1, paused: true, maintenance: false });
  });

  it('clearLocalSafely snapshots and clears business data while preserving settings and resetting seed markers', async () => {
    await seedOldState();
    await db.settings.bulkPut([{ key: 'seeded', value: '1' }, { key: 'sessionsMigrated', value: '1' },
      { key: 'expiryWarnDays', value: '14' }]);
    const result = await clearLocalSafely();
    expect(result.snapshot.file.data.orders.map((row) => row.id)).toEqual(['old-order']);
    for (const table of [db.products, db.batches, db.orders, db.lines, db.adjustments, db.sessions,
      db.outbox, db.conflicts, db.remotePendingLines, db.remoteOrderUndo]) expect(await table.count()).toBe(0);
    expect((await db.settings.get('seeded'))?.value).toBe('');
    expect((await db.settings.get('sessionsMigrated'))?.value).toBe('');
    expect((await db.settings.get('expiryWarnDays'))?.value).toBe('14');
    expect((await db.settings.get('deviceId'))?.value).toBe(DEVICE);
    expect(await readSyncControl()).toMatchObject({ generation: result.generation, paused: true, reason: 'clear-local' });
  });

  it('clears the local merge undo pointer when clearing business data', async () => {
    await seedOldState();
    await db.settings.put({ key: 'mergeUndoSnapshotId', value: '42' });
    await clearLocalSafely();
    expect(await db.settings.get('mergeUndoSnapshotId')).toBeUndefined();
  });

  it('restores parsed v1 backups without sessions and snapshot restore reuses the same boundary', async () => {
    const legacy = parseBackup(JSON.stringify({ app: 'yanhuo-erp', version: 1,
      data: { products: [makeProduct('legacy')], orders: [makeOrder('legacy-order', 50)] } }));
    await restoreLocalBackup(legacy);
    expect(await db.sessions.count()).toBe(0);
    expect(await db.orders.get('legacy-order')).toBeTruthy();
    const snapshot = await createSnapshot('manual', legacy);
    await db.outbox.put({ id: 'product:legacy', recordId: 'legacy', kind: 'product', op: 'delete', queuedAt: 1 });
    expect((await restoreSnapshot(snapshot.id!)).id).toBe(snapshot.id);
    expect(await db.outbox.count()).toBe(0);
    expect(await readSyncControl()).toMatchObject({ generation: 2, paused: true, maintenance: false });
  });
});

describe('importMerge outbox atomicity', () => {
  it('outbox failure rolls the business merge back in the same transaction', async () => {
    await db.products.put(makeProduct('existing'));
    const before = await localState();
    const hook = () => { throw new Error('enqueue failed'); };
    db.outbox.hook('creating', hook);
    try {
      await expect(importMerge(file({ products: [makeProduct('new-product')] }))).rejects.toThrow('enqueue failed');
    } finally { db.outbox.hook('creating').unsubscribe(hook); }
    expect(await localState()).toEqual(before);
  });

  it('enqueues only actually changed rows and ignores local-only settings using the outbox skip rules', async () => {
    await db.products.bulkPut([makeProduct('unrelated'), makeProduct('keep'), makeProduct('update')]);
    await db.orders.put(makeOrder('old-order', 100));
    await db.sessions.put(makeSession('unchanged-session'));
    await db.settings.bulkPut([{ key: 'same', value: 'same' }, { key: 'deviceId', value: DEVICE }]);
    const result = await importMerge(file({
      products: [makeProduct('keep'), makeProduct('update', { name: 'updated', updatedAt: '2026-11-02T00:00:00Z' }), makeProduct('new-product')],
      batches: [makeBatch('new-batch', 'new-product', 2, 10)],
      orders: [makeOrder('old-order', 999), makeOrder('new-order', 100)],
      lines: [makeLine('new-line', 'new-order', 'new-product', 1, 100)],
      adjustments: [makeAdjustment('new-adjustment', 'new-product', -1)],
      sessions: [makeSession('unchanged-session'), makeSession('new-session')],
      settings: [{ key: 'same', value: 'same' }, { key: 'changed', value: 'new' },
        { key: UNKNOWN_KINDS_KEY, value: '["foreign"]' }, { key: 'operatorA', value: 'foreign' }]
    }));
    expect((await db.outbox.toArray()).map((row) => row.id).sort()).toEqual([
      'product:update', 'product:new-product', 'batch:new-batch', 'order:new-order', 'line:new-line',
      'adjustment:new-adjustment', 'session:new-session', 'setting:changed', 'setting:lastImportAt'
    ].sort());
    expect(result.sessionsUpdated).toBe(0);
    expect(result.settingsImported).toBe(1);
    expect(await db.settings.get(UNKNOWN_KINDS_KEY)).toBeUndefined();
  });
});
