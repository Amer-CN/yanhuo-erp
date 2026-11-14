import Dexie, { type Table } from 'dexie';
import { db as mainDb } from './db';
import type { SyncCallback, SyncControlErrorCode, SyncControlRow, SyncLease } from './syncTypes';
export type { SyncCallback, SyncControlRow, SyncLease } from './syncTypes';

const LEASE_MS = 30_000;
const HEARTBEAT_MS = 10_000;
const initial = (): SyncControlRow => ({
  key: 'state', generation: 0, paused: false, reason: null,
  maintenance: false, fence: 0, ownerId: null, expiresAt: 0
});

export class SyncControlError extends Error {
  constructor(readonly code: SyncControlErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class SyncPausedError extends SyncControlError {
  constructor(readonly reason: string | null) { super('SYNC_PAUSED', reason ?? '同步已暂停'); }
}
export class SyncBusyError extends SyncControlError {
  constructor() { super('SYNC_BUSY', '另一个同步或维护操作正在进行'); }
}
export class SyncLeaseLostError extends SyncControlError {
  constructor() { super('SYNC_LEASE_LOST', '同步租约已失效'); }
}
export class SyncMaintenanceError extends SyncControlError {
  constructor() { super('SYNC_MAINTENANCE', '账本维护中，请稍后再试'); }
}
export class SyncGenerationMismatchError extends SyncControlError {
  constructor() { super('SYNC_GENERATION_MISMATCH', '暂停状态已改变，请重新确认'); }
}

/** 事务只覆盖控制行读写；调用方必须在每个业务提交事务内再次 assertCurrent。 */
export class SyncCoordinator {
  private readonly controllers = new Map<SyncLease, AbortController>();

  constructor(private readonly db: Dexie, private readonly table: Table<SyncControlRow, string>) {}

  private transaction<T>(mode: 'r' | 'rw', run: () => Promise<T>): Promise<T> {
    const tx = Dexie.currentTransaction;
    if (tx?.db === this.db && tx.storeNames.includes(this.table.name)) return run();
    return this.db.transaction(mode, this.table, run);
  }

  private state(): Promise<SyncControlRow> {
    return this.table.get('state').then((row) => row ?? initial());
  }

  read(): Promise<SyncControlRow> { return this.transaction('r', () => this.state()); }

  private matches(row: SyncControlRow, lease: SyncLease): boolean {
    return !lease.signal.aborted && row.generation === lease.generation &&
      row.ownerId === lease.ownerId && row.fence === lease.fence && row.expiresAt > Date.now() &&
      row.maintenance === lease.maintenance && (lease.maintenance || !row.paused);
  }

  private abortOlder(generation: number): void {
    for (const [lease, controller] of this.controllers) {
      if (lease.generation < generation) controller.abort(new SyncLeaseLostError());
    }
  }

  async assertCurrent(lease: SyncLease): Promise<void> {
    if (lease.signal.aborted) throw new SyncLeaseLostError();
    await this.transaction('r', async () => {
      if (!this.matches(await this.state(), lease)) throw new SyncLeaseLostError();
    });
  }

  async assertWritable(): Promise<void> {
    await this.transaction('r', async () => {
      // 过期维护也必须显式完成/接管后才解锁，不能因页面挂起自动放行写入。
      if ((await this.state()).maintenance) throw new SyncMaintenanceError();
    });
  }

  async pause(reason: string): Promise<SyncControlRow> {
    const paused = await this.transaction('rw', async () => {
      const row = await this.state();
      if (row.maintenance) throw new SyncMaintenanceError();
      const next = { ...row, generation: row.generation + 1, paused: true, reason,
        ownerId: null, expiresAt: 0 };
      await this.table.put(next);
      return next;
    });
    this.abortOlder(paused.generation);
    return paused;
  }

  resume(expectedGeneration: number): Promise<SyncControlRow> {
    return this.transaction('rw', async () => {
      const row = await this.state();
      if (row.maintenance) throw new SyncMaintenanceError();
      if (row.generation !== expectedGeneration) throw new SyncGenerationMismatchError();
      const next = { ...row, paused: false, reason: null };
      await this.table.put(next);
      return next;
    });
  }

  private async acquire(maintenance: boolean, reason?: string): Promise<SyncLease> {
    const ownerId = crypto.randomUUID();
    const row = await this.transaction('rw', async () => {
      const current = await this.state();
      if (maintenance) {
        if (current.maintenance && current.ownerId && current.expiresAt > Date.now()) {
          throw new SyncBusyError();
        }
      } else {
        if (current.paused || current.maintenance) throw new SyncPausedError(current.reason);
        if (current.ownerId && current.expiresAt > Date.now()) throw new SyncBusyError();
      }
      const next: SyncControlRow = {
        ...current, ownerId, fence: current.fence + 1, expiresAt: Date.now() + LEASE_MS,
        ...(maintenance ? { generation: current.generation + 1, paused: true,
          maintenance: true, reason: reason ?? null } : {})
      };
      await this.table.put(next);
      return next;
    });
    if (maintenance) this.abortOlder(row.generation);
    const controller = new AbortController();
    const lease: SyncLease = Object.freeze({ generation: row.generation, ownerId,
      fence: row.fence, maintenance, signal: controller.signal });
    this.controllers.set(lease, controller);
    return lease;
  }

  private heartbeat(lease: SyncLease): Promise<void> {
    return this.transaction('rw', async () => {
      const row = await this.state();
      if (!this.matches(row, lease)) throw new SyncLeaseLostError();
      await this.table.update('state', { expiresAt: Date.now() + LEASE_MS });
    });
  }

  private release(lease: SyncLease): Promise<void> {
    return this.transaction('rw', async () => {
      const row = await this.state();
      if (row.ownerId !== lease.ownerId || row.fence !== lease.fence) return;
      await this.table.put({ ...row, ownerId: null, expiresAt: 0,
        ...(lease.maintenance ? { maintenance: false, paused: true } : {}) });
    });
  }

  private async run<T>(maintenance: boolean, callback: SyncCallback<T>, reason?: string): Promise<T> {
    const lease = await this.acquire(maintenance, reason);
    const controller = this.controllers.get(lease)!;
    let stopped = false;
    let pending: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (stopped || pending || controller.signal.aborted) return;
      pending = this.heartbeat(lease).catch(() => {
        controller.abort(new SyncLeaseLostError());
      }).finally(() => { pending = undefined; });
    }, HEARTBEAT_MS);
    let failed = false;
    let failure: unknown;
    let result!: T;
    try {
      await this.assertCurrent(lease);
      // 脱离任何 ambient transaction；异步外部工作不会让 IDB 事务一直占用。
      result = await Dexie.ignoreTransaction(() => callback(lease));
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      stopped = true;
      clearInterval(timer);
      await pending;
      this.controllers.delete(lease);
      try { await this.release(lease); } catch (error) {
        if (!failed) { failed = true; failure = error; }
      }
    }
    if (failed) throw failure;
    return result;
  }

  runExclusive<T>(callback: SyncCallback<T>): Promise<T> { return this.run(false, callback); }
  runMaintenance<T>(reason: string, callback: SyncCallback<T>): Promise<T> {
    return this.run(true, callback, reason);
  }
}

// 同步懒取表：导入不打开主库，首次事务内校验也不会等待模块加载。
let production: SyncCoordinator | undefined;
function coordinator(): SyncCoordinator {
  if (production) return production;
  const table = mainDb.table<SyncControlRow, string>('syncMeta');
  production = new SyncCoordinator(mainDb, table);
  return production;
}

export function __setSyncControlForTest(value?: SyncCoordinator): void {
  production = value;
}
export function readSyncControl(): Promise<SyncControlRow> { return coordinator().read(); }
export function pauseSync(reason: string): Promise<SyncControlRow> { return coordinator().pause(reason); }
export function resumeSync(expectedGeneration: number): Promise<SyncControlRow> {
  return coordinator().resume(expectedGeneration);
}
export function runSyncExclusive<T>(callback: SyncCallback<T>): Promise<T> {
  return coordinator().runExclusive(callback);
}
export function assertLeaseCurrent(lease: SyncLease): Promise<void> {
  return coordinator().assertCurrent(lease);
}
export function runMaintenance<T>(reason: string, callback: SyncCallback<T>): Promise<T> {
  return coordinator().runMaintenance(reason, callback);
}
export function assertWritable(): Promise<void> { return coordinator().assertWritable(); }
