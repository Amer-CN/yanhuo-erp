// 本地自动备份：独立 Dexie 库，与主库 yanhuo-erp 分离。
// 主库升级/清空不会连带清掉备份；备份库自己的 schema 也保持极简（只有 snapshots 一张表）。

import Dexie, { type Table } from 'dexie';
import { db, SCHEMA_VERSION } from './db';
import { exportBackup, replaceAll, type BackupFile } from './merge';
import { ensureDeviceId } from './repo';
import {
  SETTING_KEYS,
  type Adjustment,
  type AppData,
  type Batch,
  type Product,
  type SaleLine,
  type SalesOrder,
  type Session,
  type Setting
} from './types';

export type SnapshotReason = 'close' | 'manual' | 'pre-migrate';

export interface SnapshotRow {
  id?: number;
  at: string;
  reason: SnapshotReason;
  schemaVersion: number;
  deviceId: string;
  /** 与手动导出完全相同的备份结构 */
  file: BackupFile;
}

class BackupDB extends Dexie {
  snapshots!: Table<SnapshotRow, number>;

  constructor() {
    super('yanhuo-erp-backup');
    this.version(1).stores({ snapshots: '++id, at, reason' });
  }
}

export const backupDb = new BackupDB();

/** 生成一份快照并落库；调用方负责把失败转成非阻断提示 */
export async function createSnapshot(reason: SnapshotReason): Promise<SnapshotRow> {
  const deviceId = await ensureDeviceId();
  const file = await exportBackup(deviceId);
  const row: SnapshotRow = {
    at: new Date().toISOString(),
    reason,
    schemaVersion: db.verno,
    deviceId,
    file
  };
  const id = await backupDb.snapshots.add(row);
  await pruneSnapshots();
  return { ...row, id };
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
  const all = await listSnapshots();
  const keep = new Set<number>();
  const dates = new Set<string>();
  let latestPreMigrate: SnapshotRow | undefined;

  for (const row of all) {
    if (!latestPreMigrate && row.reason === 'pre-migrate') latestPreMigrate = row;
    if (dates.size >= 3) continue;
    const date = row.at.slice(0, 10);
    if (dates.has(date)) continue;
    dates.add(date);
    if (row.id != null) keep.add(row.id);
  }
  if (latestPreMigrate?.id != null) keep.add(latestPreMigrate.id);

  const remove = all
    .filter((row) => row.id != null && !keep.has(row.id))
    .map((row) => row.id as number);
  if (remove.length > 0) await backupDb.snapshots.bulkDelete(remove);
  return remove.length;
}

/**
 * 恢复到某份快照：整库替换后默认关闭云同步，
 * 避免旧快照把另一台设备上较新的云端数据覆盖掉。确认对话框由设置页负责。
 */
export async function restoreSnapshot(id: number): Promise<SnapshotRow> {
  const row = await backupDb.snapshots.get(id);
  if (!row) throw new Error('找不到这份本地备份');
  await replaceAll(row.file);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem('yh-sync-disabled', '1');
  } catch {
    // 单测（Node）没有 localStorage，忽略即可
  }
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
    (s) => s.key === SETTING_KEYS.sessionsMigrated && s.value === 'yes'
  );
  if (migrated) return false;
  return data.orders.some((o) => !o.sessionId);
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