// 本地自动备份：独立 Dexie 库，与主库 yanhuo-erp 分离。
// 主库升级/清空不会连带清掉备份；备份库自己的 schema 也保持极简（只有 snapshots 一张表）。

import Dexie, { type Table } from 'dexie';
import { db, SCHEMA_VERSION } from './db';
import { exportBackup, type BackupFile } from './merge';
import { restoreLocalBackup } from './dataRecovery';
import { ensureDeviceId } from './repo';
import { uuid } from './util';
import {
  SETTING_KEYS,
  SESSIONS_MIGRATED_VALUE,
  type Adjustment,
  type AppData,
  type Batch,
  type Product,
  type SaleLine,
  type SalesOrder,
  type Session,
  type Setting
} from './types';

export type SnapshotReason = 'close' | 'manual' | 'pre-migrate' | 'pre-recovery' | 'pre-merge';

export interface SnapshotRow {
  id?: number;
  at: string;
  reason: SnapshotReason;
  schemaVersion: number;
  deviceId: string;
  /** 与手动导出完全相同的备份结构 */
  file: BackupFile;
  /** pre-merge 提交前为 true；成功后转正，未被指针引用的 pending 可清理。 */
  pending?: boolean;
  /** 跨标签页预留令牌；只有持有者能提交或放弃。 */
  reservationToken?: string;
  /** 预留到期时间；崩溃遗留只在过期后回收。 */
  reservationExpiresAt?: number;
}

class BackupDB extends Dexie {
  snapshots!: Table<SnapshotRow, number>;

  constructor() {
    super('yanhuo-erp-backup');
    this.version(1).stores({ snapshots: '++id, at, reason' });
  }
}

export const backupDb = new BackupDB();

/** 生成并持久保存快照；恢复路径传入维护中捕获的 file，避开业务写入守门。 */
export async function createSnapshot(reason: SnapshotReason, captured?: BackupFile, prune = true): Promise<SnapshotRow> {
  const deviceId = captured?.deviceId ?? await ensureDeviceId();
  const file = captured ?? await exportBackup(deviceId);
  const reserved = reason === 'pre-merge' && !prune;
  const row: SnapshotRow = {
    at: new Date().toISOString(),
    reason,
    schemaVersion: db.verno,
    deviceId,
    file,
    ...(reserved ? { pending: true, reservationToken: uuid(), reservationExpiresAt: Date.now() + 24 * 60 * 60_000 } : {})
  };
  const id = reserved
    ? await backupDb.transaction('rw', backupDb.snapshots, () => backupDb.snapshots.add(row))
    : await backupDb.snapshots.add(row);
  if (prune) await pruneSnapshots();
  return { ...row, id };
}

async function ownedPendingSnapshot(id: number, token: string): Promise<SnapshotRow> {
  const row = await backupDb.snapshots.get(id);
  if (!row?.pending || row.reservationToken !== token) throw new Error('合并快照预留已失效或不属于本页');
  return row;
}

/** 合并提交成功后把 pre-merge 快照转为正式撤销点。 */
export async function markSnapshotCommitted(id: number, token: string): Promise<void> {
  await backupDb.transaction('rw', backupDb.snapshots, async () => {
    await ownedPendingSnapshot(id, token);
    await backupDb.snapshots.update(id, { pending: false, reservationToken: undefined, reservationExpiresAt: undefined });
  });
}

/** 合并失败/取消后显式放弃预留，快照可立即回收。 */
export async function abandonSnapshot(id: number, token: string): Promise<void> {
  await backupDb.transaction('rw', backupDb.snapshots, async () => {
    await ownedPendingSnapshot(id, token);
    await backupDb.snapshots.delete(id);
  });
}

/** 最近的在最前 */
export async function listSnapshots(): Promise<SnapshotRow[]> {
  return backupDb.snapshots.orderBy('at').reverse().toArray();
}

export async function latestSnapshot(): Promise<SnapshotRow | undefined> {
  return (await listSnapshots())[0];
}

/** 保留最近 3 个不同日期的快照 + 最近 1 份 pre-migrate，其余删除；返回删除条数 */
export async function pruneSnapshots(): Promise<number> {
  const mainOpen = db.isOpen();
  const pointer = mainOpen ? await db.settings.get(SETTING_KEYS.mergeUndoSnapshotId) : undefined;
  const pointedId = Number(pointer?.value);
  return backupDb.transaction('rw', backupDb.snapshots, async () => {
    const all = await backupDb.snapshots.orderBy('at').reverse().toArray();
    const keep = new Set<number>();
    if (mainOpen && Number.isSafeInteger(pointedId) && pointedId > 0) keep.add(pointedId);
    const now = Date.now();
    const dates = new Set<string>();
    let latestPreMigrate: SnapshotRow | undefined;

    for (const row of all) {
      if (row.pending) {
        // 冷启动无法读取撤销指针；活跃跨标签页预留也必须保留。
        if (!mainOpen || (row.reservationToken && (row.reservationExpiresAt ?? 0) > now)) {
          if (row.id != null) keep.add(row.id);
        }
        continue;
      }
      if (!latestPreMigrate && row.reason === 'pre-migrate') latestPreMigrate = row;
      if (dates.size >= 3) continue;
      const date = row.at.slice(0, 10);
      if (dates.has(date)) continue;
      dates.add(date);
      if (row.id != null) keep.add(row.id);
    }
    if (latestPreMigrate?.id != null) keep.add(latestPreMigrate.id);
    // 自增 id 表示真实保存顺序，设备时间回拨也不会误删最新恢复/合并安全快照。
    const latestRecovery = all.filter((row) => row.reason === 'pre-recovery' && !row.pending)
      .reduce<SnapshotRow | undefined>((latest, row) => !latest || (row.id ?? 0) > (latest.id ?? 0) ? row : latest, undefined);
    const latestPreMerge = all.filter((row) => row.reason === 'pre-merge' && !row.pending)
      .reduce<SnapshotRow | undefined>((latest, row) => !latest || (row.id ?? 0) > (latest.id ?? 0) ? row : latest, undefined);
    if (latestRecovery?.id != null) keep.add(latestRecovery.id);
    if (latestPreMerge?.id != null) keep.add(latestPreMerge.id);

    const remove = all
      .filter((row) => row.id != null && !keep.has(row.id))
      .map((row) => row.id as number);
    if (remove.length > 0) await backupDb.snapshots.bulkDelete(remove);
    return remove.length;
  });
}

/**
 * 恢复到某份快照：整库替换后默认关闭云同步，
 * 避免旧快照把另一台设备上较新的云端数据覆盖掉。确认对话框由设置页负责。
 */
export async function restoreSnapshot(id: number): Promise<SnapshotRow> {
  const row = await backupDb.snapshots.get(id);
  if (!row) throw new Error('找不到这份本地备份');
  const file: BackupFile = {
    ...row.file,
    data: {
      ...row.file.data,
      settings: row.file.data.settings.filter((setting) => setting.key !== SETTING_KEYS.mergeUndoSnapshotId)
    }
  };
  await restoreLocalBackup(file);
  return row;
}

/* --------------------------------- 迁移前快照 --------------------------------- */

const MAIN_DB_NAME = 'yanhuo-erp';

/** 以「当前版本」打开主库：不传 version，因此不会触发 Dexie 升级 */
function openMainRaw(): Promise<{ idb: IDBDatabase; created: boolean }> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MAIN_DB_NAME);
    let created = false;
    req.onupgradeneeded = () => {
      created = true;
    };
    req.onsuccess = () => resolve({ idb: req.result, created });
    req.onerror = () => reject(req.error ?? new Error('打开主库失败'));
    req.onblocked = () => reject(new Error('主库被其他标签页占用'));
  });
}

function readStore<T>(idb: IDBDatabase, name: string): Promise<T[]> {
  if (!idb.objectStoreNames.contains(name)) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(name, 'readonly');
    const req = tx.objectStore(name).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error ?? new Error(`读取 ${name} 失败`));
    tx.onabort = () => reject(tx.error ?? new Error(`读取 ${name} 被中止`));
  });
}

/** 迁移逻辑与 repo.migrateSessions 的前置条件保持一致 */
function needsSessionMigration(data: AppData): boolean {
  const migrated = data.settings.some(
    (s) => s.key === SETTING_KEYS.sessionsMigrated && s.value === SESSIONS_MIGRATED_VALUE
  );
  if (migrated) return false;
  return data.orders.some((o) => !o.sessionId);
}

/**
 * 只读 settings（小表）判断场次迁移是否已经做过。
 * 启动快路径靠它避开「为了判断要不要迁移而把整库读进 JS」。
 */
async function hasSessionMigrationMark(idb: IDBDatabase): Promise<boolean> {
  const settings = await readStore<Setting>(idb, 'settings');
  return settings.some(
    (s) => s.key === SETTING_KEYS.sessionsMigrated && s.value === SESSIONS_MIGRATED_VALUE
  );
}

/**
 * 用 count 判断订单里是否还有缺 sessionId 的记录。
 * `sessionId` 是 v3 起的索引，没有值的记录不进索引，因此
 * `索引 count < 总 count` 等价于「存在待迁移订单」，但不需要把订单正文
 * 结构化克隆到 JS —— 这正是启动链上最贵的那一步。
 */
function hasOrdersWithoutSession(idb: IDBDatabase): Promise<boolean> {
  if (!idb.objectStoreNames.contains('orders')) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('orders', 'readonly');
    const store = tx.objectStore('orders');
    if (!store.indexNames.contains('sessionId')) {
      // v3 之前的库：没有索引，一定需要迁移
      resolve(true);
      return;
    }
    let total = -1;
    let withSession = -1;
    const done = () => {
      if (total >= 0 && withSession >= 0) resolve(withSession < total);
    };
    const totalReq = store.count();
    totalReq.onsuccess = () => {
      total = totalReq.result;
      done();
    };
    totalReq.onerror = () => reject(totalReq.error ?? new Error('统计订单失败'));
    const sessionReq = store.index('sessionId').count();
    sessionReq.onsuccess = () => {
      withSession = sessionReq.result;
      done();
    };
    sessionReq.onerror = () => reject(sessionReq.error ?? new Error('统计场次订单失败'));
  });
}

export interface SnapshotBeforeOpenResult {
  created: boolean;
  version: number;
  snapshotId?: number;
}

/**
 * 在 Dexie 首次打开主库之前落一份 pre-migrate 快照。
 * - 首次启动（库不存在）：原生 open 会创建空库，标记 created 并直接返回，不生成快照；
 * - 仅当 oldVersion < SCHEMA_VERSION，或 migrateSessions 即将执行时生成；
 * - 失败由调用方静默处理，不阻断启动。
 */
export async function snapshotBeforeOpen(): Promise<SnapshotBeforeOpenResult> {
  const { idb, created } = await openMainRaw();
  const version = idb.version;
  try {
    if (created) return { created, version };

    /*
     * 启动快路径（绝大多数启动都会走这里）：
     * 版本没变、场次迁移也做过、且没有缺 sessionId 的新单时，直接返回。
     * 旧实现无条件把 7 张表读进 JS，只为做上面这两个判断；订单/流水是最大的两张表，
     * 数据攒到几千单后，这段纯判断会占掉首屏几百毫秒。
     */
    if (version >= SCHEMA_VERSION && (await hasSessionMigrationMark(idb))) {
      if (!(await hasOrdersWithoutSession(idb))) return { created, version };
    }

    const data: AppData = {
      products: await readStore<Product>(idb, 'products'),
      batches: await readStore<Batch>(idb, 'batches'),
      orders: await readStore<SalesOrder>(idb, 'orders'),
      lines: await readStore<SaleLine>(idb, 'lines'),
      adjustments: await readStore<Adjustment>(idb, 'adjustments'),
      sessions: await readStore<Session>(idb, 'sessions'),
      settings: await readStore<Setting>(idb, 'settings')
    };

    if (version >= SCHEMA_VERSION && !needsSessionMigration(data)) {
      return { created, version };
    }

    const deviceId = data.settings.find((s) => s.key === SETTING_KEYS.deviceId)?.value ?? '';
    const at = new Date().toISOString();
    const row: SnapshotRow = {
      at,
      reason: 'pre-migrate',
      schemaVersion: version,
      deviceId,
      file: { app: 'yanhuo-erp', version: 2, exportedAt: at, deviceId, data }
    };
    const snapshotId = await backupDb.snapshots.add(row);
    await pruneSnapshots();
    return { created, version, snapshotId };
  } finally {
    idb.close();
  }
}