// B05a：独立数据库、真实 fake-indexeddb；只使用显式 gate 和假的 Date，不访问网络。
import 'fake-indexeddb/auto';
import Dexie, { type Table, type Transaction } from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SyncCoordinator,
  SyncBusyError,
  SyncGenerationMismatchError,
  SyncLeaseLostError,
  SyncMaintenanceError,
  SyncPausedError,
  assertLeaseCurrent,
  assertWritable,
  __setSyncControlForTest,
  pauseSync,
  readSyncControl,
  resumeSync,
  runMaintenance,
  runSyncExclusive
} from '../src/db/syncControl';
import type { SyncControlRow, SyncLease } from '../src/db/syncTypes';

// facade 也只接到本测试创建的独立库，真实主库从未打开。
const main = vi.hoisted(() => ({ db: undefined as Dexie | undefined }));
vi.mock('../src/db/db', () => ({ get db() { return main.db; } }));

const NOW = Date.parse('2026-11-14T12:00:00Z');

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let name: string;
let databases: Dexie[];
let table: Table<SyncControlRow, string>;
let first: SyncCoordinator;
let second: SyncCoordinator;
let releases: (() => void)[];
let runs: Promise<unknown>[];
let heartbeats: (() => void)[];

async function connection() {
  const db = new Dexie(name);
  databases.push(db);
  db.version(1).stores({ syncMeta: 'key' });
  await db.open();
  return { db, table: db.table<SyncControlRow, string>('syncMeta') };
}

function hold(coordinator = first) {
  const entered = gate<SyncLease>();
  const release = gate();
  releases.push(() => release.resolve());
  const running = coordinator.runExclusive(async (lease) => {
    entered.resolve(lease);
    await release.promise;
  });
  void running.catch(() => {});
  runs.push(running);
  return { entered: entered.promise, release: () => release.resolve(), running };
}

beforeEach(async () => {
  databases = [];
  releases = [];
  runs = [];
  heartbeats = [];
  name = `random-test-sync-control-${crypto.randomUUID()}`;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  // 截获周期调度入口，手工触发真实 IDB 心跳，不伪造 IDB 所需的任务队列。
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay: number) => {
    expect(delay).toBe(10_000);
    heartbeats.push(callback);
    return heartbeats.length as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval);
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('sync-control test must never use network'); }));
  const a = await connection();
  const b = await connection();
  table = a.table;
  first = new SyncCoordinator(a.db, a.table);
  second = new SyncCoordinator(b.db, b.table);
});

afterEach(async () => {
  releases.forEach((release) => release());
  await Promise.allSettled(runs);
  databases.forEach((db) => db.close());
  await Dexie.delete(name);
  __setSyncControlForTest(undefined);
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('生产 facade 的事务边界', () => {
  it('首次 assertWritable 必须复用调用方事务，不可因 lazy await 提前提交', async () => {
    main.db = databases[0];
    __setSyncControlForTest(new SyncCoordinator(databases[0], table));
    const seen: (Transaction | undefined)[] = [];
    const onReading = (row: unknown) => { seen.push(Dexie.currentTransaction); return row; };
    table.hook('reading', onReading);
    try {
      await databases[0].transaction('rw', table, async (tx) => {
        await assertWritable();
        expect(seen).toHaveLength(1);
        expect(seen[0]).toBe(tx);
        await table.put({
          key: 'state', generation: 0, dataGeneration: 0, paused: false, reason: null,
          maintenance: false, fence: 0, ownerId: null, expiresAt: 0
        });
      });
      const paused = await pauseSync('facade 暂停');
      expect(await readSyncControl()).toEqual(paused);
      await resumeSync(paused.generation);
      await runSyncExclusive(async (lease) => {
        await databases[0].transaction('rw', table, async (tx) => {
          seen.length = 0;
          await assertLeaseCurrent(lease);
          expect(seen).toHaveLength(1);
          expect(seen[0]).toBe(tx);
        });
      });
      await runMaintenance('facade 维护', async (lease) => { await assertLeaseCurrent(lease); });
      await assertWritable();
      expect(await readSyncControl()).toMatchObject({ paused: true, maintenance: false });
    } finally {
      table.hook('reading').unsubscribe(onReading);
    }
  });
});

describe('持久化同步租约', () => {
  it('新库返回 state 默认值；callback 在事务外，租约持有 30 秒且 finally 释放', async () => {
    expect(await first.read()).toEqual({
      key: 'state', generation: 0, dataGeneration: 0, paused: false, reason: null,
      maintenance: false, fence: 0, ownerId: null, expiresAt: 0
    });
    const result = await first.runExclusive(async (lease) => {
      expect(Dexie.currentTransaction).toBeFalsy();
      expect(lease).toMatchObject({ generation: 0, fence: 1, maintenance: false });
      expect(lease.ownerId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(lease.signal.aborted).toBe(false);
      await first.assertCurrent(lease);
      expect(await first.read()).toMatchObject({
        ownerId: lease.ownerId, fence: 1, expiresAt: NOW + 30_000
      });
      return 42;
    });
    expect(result).toBe(42);
    expect(await first.read()).toMatchObject({ fence: 1, ownerId: null, expiresAt: 0 });
  });

  it('两个独立连接竞争只让一个 callback 进入，另一个抛 typed busy', async () => {
    const release = gate();
    releases.push(() => release.resolve());
    const entered = gate<SyncLease>();
    const callbacks: SyncLease[] = [];
    const callback = async (lease: SyncLease) => {
      callbacks.push(lease);
      entered.resolve(lease);
      await release.promise;
      return lease.ownerId;
    };
    const a = first.runExclusive(callback);
    const b = second.runExclusive(callback);
    void a.catch(() => {});
    void b.catch(() => {});
    runs.push(a, b);
    await entered.promise;
    const rejected = await Promise.race([
      a.then(() => undefined, (error: unknown) => error),
      b.then(() => undefined, (error: unknown) => error)
    ]);
    expect(rejected).toBeInstanceOf(SyncBusyError);
    expect(callbacks).toHaveLength(1);
    release.resolve();
    const settled = await Promise.allSettled([a, b]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('pause 先提交 generation/暂停原因并释放 owner，再 abort 本机 callback', async () => {
    const run = hold();
    const lease = await run.entered;
    const abortObserved = gate<Promise<SyncControlRow>>();
    lease.signal.addEventListener('abort', () => abortObserved.resolve(second.read()), { once: true });
    const paused = await first.pause('恢复备份');
    expect(paused).toMatchObject({
      generation: lease.generation + 1, paused: true, reason: '恢复备份', ownerId: null, expiresAt: 0
    });
    expect(await abortObserved.promise).toMatchObject(paused);
    expect(lease.signal.aborted).toBe(true);
    await expect(second.runExclusive(() => undefined)).rejects.toBeInstanceOf(SyncPausedError);
    await expect(second.assertCurrent(lease)).rejects.toBeInstanceOf(SyncLeaseLostError);
  });

  it('pause 经连接关闭、重新构造 coordinator 后仍然保持', async () => {
    const paused = await first.pause('人工暂停');
    databases.forEach((db) => db.close());
    const reopened = await connection();
    const rebuilt = new SyncCoordinator(reopened.db, reopened.table);
    expect(await rebuilt.read()).toEqual(paused);
    await expect(rebuilt.runExclusive(() => undefined)).rejects.toBeInstanceOf(SyncPausedError);
  });

  it('另实例 pause 后旧 lease 即便未 abort 也不能通过 assert，resume 也不能复活旧 lease', async () => {
    const run = hold();
    const lease = await run.entered;
    const paused = await second.pause('另一个页面暂停');
    await expect(first.assertCurrent(lease)).rejects.toBeInstanceOf(SyncLeaseLostError);
    await second.resume(paused.generation);
    await expect(first.assertCurrent(lease)).rejects.toBeInstanceOf(SyncLeaseLostError);
  });

  it('resume 用 expectedGeneration 做 CAS，陈旧请求不能覆盖更新的暂停', async () => {
    const older = await first.pause('先暂停');
    const newer = await second.pause('后来暂停');
    await expect(first.resume(older.generation)).rejects.toBeInstanceOf(SyncGenerationMismatchError);
    expect(await first.read()).toEqual(newer);
    expect(await first.resume(newer.generation)).toMatchObject({
      generation: newer.generation, paused: false, reason: null
    });
    await first.runExclusive(() => undefined);
  });

  it.each(['generation', 'ownerId', 'fence', 'expiresAt', 'paused'] as const)(
    'assertCurrent 校验 %s，拒绝不再匹配的 lease', async (field) => {
      const run = hold();
      const lease = await run.entered;
      const row = await first.read();
      const changed: SyncControlRow = {
        ...row,
        ...(field === 'generation' ? { generation: row.generation + 1 } : {}),
        ...(field === 'ownerId' ? { ownerId: crypto.randomUUID() } : {}),
        ...(field === 'fence' ? { fence: row.fence + 1 } : {}),
        ...(field === 'expiresAt' ? { expiresAt: NOW } : {}),
        ...(field === 'paused' ? { paused: true } : {})
      };
      await table.put(changed);
      await expect(first.assertCurrent(lease)).rejects.toBeInstanceOf(SyncLeaseLostError);
    }
  );

  it('租期恰好过期可接管；旧 finally 不会释放新 owner，fence 单调递增', async () => {
    const oldRun = hold();
    const oldLease = await oldRun.entered;
    vi.setSystemTime(NOW + 29_999);
    await expect(second.runExclusive(() => undefined)).rejects.toBeInstanceOf(SyncBusyError);
    vi.setSystemTime(NOW + 30_000);
    const newRun = hold(second);
    const newLease = await newRun.entered;
    expect(newLease.fence).toBe(oldLease.fence + 1);
    expect(newLease.ownerId).not.toBe(oldLease.ownerId);
    await expect(first.assertCurrent(oldLease)).rejects.toBeInstanceOf(SyncLeaseLostError);
    oldRun.release();
    await Promise.allSettled([oldRun.running]);
    expect(await second.read()).toMatchObject({ ownerId: newLease.ownerId, fence: newLease.fence });
    await second.assertCurrent(newLease);
    newRun.release();
    await newRun.running;
    await first.runExclusive((lease) => { expect(lease.fence).toBe(newLease.fence + 1); });
  });

  it('callback 抛错仍释放租约，保留原错误，另一实例随后可取得锁', async () => {
    const failure = new Error('callback failed');
    await expect(first.runExclusive(() => { throw failure; })).rejects.toBe(failure);
    expect(await second.read()).toMatchObject({ ownerId: null, expiresAt: 0 });
    await second.runExclusive((lease) => { expect(lease.fence).toBe(2); });
  });

  it('assertCurrent/assertWritable 在含 syncMeta 的调用方事务内复用同一事务', async () => {
    await first.runExclusive(async (lease) => {
      const seen: (Transaction | undefined)[] = [];
      const onReading = (row: unknown) => { seen.push(Dexie.currentTransaction); return row; };
      table.hook('reading', onReading);
      try {
        await databases[0].transaction('rw', table, async (tx) => {
          await first.assertCurrent(lease);
          await first.assertWritable();
          expect(seen.length).toBeGreaterThanOrEqual(2);
          expect(seen.every((observed) => observed === tx)).toBe(true);
        });
      } finally {
        table.hook('reading').unsubscribe(onReading);
      }
    });
  });

  it('事务内尚未提交的失效修改也必须被 assertCurrent 读到', async () => {
    const run = hold();
    const lease = await run.entered;
    const before = await first.read();
    await expect(databases[0].transaction('rw', table, async () => {
      await table.put({ ...before, generation: before.generation + 1 });
      await first.assertCurrent(lease);
    })).rejects.toBeInstanceOf(SyncLeaseLostError);
    expect(await first.read()).toEqual(before);
  });
});

describe('维护独占与写入守门', () => {
  it('维护先使旧同步失效，锁住写入和恢复；结束仍保持 paused', async () => {
    const oldRun = hold();
    const oldLease = await oldRun.entered;
    const release = gate();
    const entered = gate<SyncLease>();
    releases.push(() => release.resolve());
    const maintenance = first.runMaintenance('导入账本', async (lease) => {
      expect(Dexie.currentTransaction).toBeFalsy();
      await first.assertCurrent(lease);
      entered.resolve(lease);
      await release.promise;
      return 'restored';
    });
    void maintenance.catch(() => {});
    runs.push(maintenance);
    const lease = await entered.promise;
    expect(lease.generation).toBe(oldLease.generation + 1);
    expect(lease.fence).toBe(oldLease.fence + 1);
    expect(lease.maintenance).toBe(true);
    expect(oldLease.signal.aborted).toBe(true);
    await expect(second.assertCurrent(oldLease)).rejects.toBeInstanceOf(SyncLeaseLostError);
    await expect(second.assertWritable()).rejects.toBeInstanceOf(SyncMaintenanceError);
    await expect(second.resume(lease.generation)).rejects.toBeInstanceOf(SyncMaintenanceError);
    await expect(second.runMaintenance('另一次维护', () => undefined)).rejects.toBeInstanceOf(SyncBusyError);
    release.resolve();
    await expect(maintenance).resolves.toBe('restored');
    const paused = await second.read();
    expect(paused).toMatchObject({
      generation: lease.generation, paused: true, maintenance: false,
      reason: '导入账本', ownerId: null, expiresAt: 0
    });
    await second.assertWritable();
    await expect(second.runExclusive(() => undefined)).rejects.toBeInstanceOf(SyncPausedError);
  });

  it('维护 callback 抛错也清 maintenance，继续暂停并可离线写入', async () => {
    const failure = new Error('restore failed');
    await expect(first.runMaintenance('恢复失败', () => { throw failure; })).rejects.toBe(failure);
    expect(await second.read()).toMatchObject({ paused: true, maintenance: false, ownerId: null });
    await second.assertWritable();
  });

  it('普通 paused 允许离线写入；同事务未提交的 maintenance 必须挡住写入', async () => {
    await first.pause('断开同步');
    await second.assertWritable();
    const before = await first.read();
    await expect(databases[0].transaction('rw', table, async () => {
      await table.put({ ...before, maintenance: true });
      await first.assertWritable();
    })).rejects.toBeInstanceOf(SyncMaintenanceError);
    expect(await first.read()).toEqual(before);
  });

  it('过期维护可由新维护接管，旧维护 finally 不能清新维护标记或 owner', async () => {
    const entered = gate<SyncLease>();
    const release = gate();
    releases.push(() => release.resolve());
    const oldRun = first.runMaintenance('旧维护', async (lease) => {
      entered.resolve(lease);
      await release.promise;
    });
    void oldRun.catch(() => {});
    runs.push(oldRun);
    const older = await entered.promise;
    vi.setSystemTime(NOW + 30_000);
    const newerEntered = gate<SyncLease>();
    const newerRelease = gate();
    releases.push(() => newerRelease.resolve());
    const newRun = second.runMaintenance('接管维护', async (lease) => {
      newerEntered.resolve(lease);
      await newerRelease.promise;
    });
    void newRun.catch(() => {});
    runs.push(newRun);
    const newer = await newerEntered.promise;
    expect(newer.generation).toBe(older.generation + 1);
    expect(newer.fence).toBe(older.fence + 1);
    release.resolve();
    await Promise.allSettled([oldRun]);
    expect(await second.read()).toMatchObject({ maintenance: true, ownerId: newer.ownerId, fence: newer.fence });
    await expect(first.assertWritable()).rejects.toBeInstanceOf(SyncMaintenanceError);
    newerRelease.resolve();
    await newRun;
    expect(await second.read()).toMatchObject({ maintenance: false, paused: true });
  });
});

describe('心跳 CAS 与中止', () => {
  it('10 秒心跳续至当前时间加 30 秒，新的实例仍不能抢占', async () => {
    const run = hold();
    const lease = await run.entered;
    const renewed = gate();
    const onUpdated = (changes: Partial<SyncControlRow>) => {
      if (changes.expiresAt === NOW + 40_000) renewed.resolve();
    };
    table.hook('updating', onUpdated);
    // 第二连接写也会触发另一连接的存储变化，但 Dexie hooks 只属于当前连接。
    try {
      vi.setSystemTime(NOW + 10_000);
      heartbeats[0]();
      await renewed.promise;
      // 读事务排在续租 rw 后面，确保检查的是已提交状态。
      expect(await second.read()).toMatchObject({ ownerId: lease.ownerId, expiresAt: NOW + 40_000 });
      vi.setSystemTime(NOW + 30_000);
      await expect(second.runExclusive(() => undefined)).rejects.toBeInstanceOf(SyncBusyError);
      await first.assertCurrent(lease);
    } finally {
      table.hook('updating').unsubscribe(onUpdated);
    }
  });

  it('另实例使 generation 失效后心跳 CAS 失败，旧 signal abort 且不复活租约', async () => {
    const run = hold();
    const lease = await run.entered;
    const aborted = gate();
    lease.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    const paused = await second.pause('跨实例暂停');
    vi.setSystemTime(NOW + 10_000);
    heartbeats[0]();
    await aborted.promise;
    expect(lease.signal.aborted).toBe(true);
    expect(await second.read()).toEqual(paused);
    await expect(first.assertCurrent(lease)).rejects.toBeInstanceOf(SyncLeaseLostError);
  });

  it('心跳遇到真实 IDB 关闭也 abort，释放不能清掉另一实例的 owner', async () => {
    const run = hold();
    const lease = await run.entered;
    const aborted = gate();
    lease.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    databases[0].close();
    vi.setSystemTime(NOW + 10_000);
    heartbeats[0]();
    await aborted.promise;
    expect(lease.signal.aborted).toBe(true);
    await expect(first.assertCurrent(lease)).rejects.toBeInstanceOf(SyncLeaseLostError);
    // 收尾恢复连接，让 finally 正常完成释放。
    await databases[0].open();
  });
});
