// 本地自动备份：独立 Dexie 库，与主库 yanhuo-erp 分离。
// 主库升级/清空不会连带清掉备份；备份库自己的 schema 也保持极简（只有 snapshots 一张表）。

import Dexie, { type Table } from 'dexie';
import { db } from './db';
import { exportBackup, replaceAll, type BackupFile } from './merge';
import { ensureDeviceId } from './repo';

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