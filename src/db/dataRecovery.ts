// 本机数据恢复：控制面先暂停并换代；主库替换、队列清理和恢复标记同事务提交。
import type { Table } from 'dexie';
import { db } from './db';
import type { BackupFile } from './merge';
import type { SnapshotRow } from './backup';
import { UNKNOWN_KINDS_KEY } from './outbox';
import { assertLeaseCurrent, runMaintenance, type SyncLease } from './syncControl';
import { EMPTY_DATA, SETTING_KEYS, type Setting } from './types';

export const RECOVERY_PENDING_KEY = 'recovery-pending';
interface RecoveryPendingRow {
  key: typeof RECOVERY_PENDING_KEY;
  generation: number;
  token: string;
}
const pending = db.table<RecoveryPendingRow, string>('syncMeta');
const LOCAL_IDENTITY_KEYS = [
  SETTING_KEYS.deviceId, SETTING_KEYS.deviceName,
  SETTING_KEYS.operatorA, SETTING_KEYS.operatorB, SETTING_KEYS.operatorSelf
];
const CLEANUP_KEYS = [
  'yh-sync-last-pull', 'yh-sync-last-pull-id', 'yh-sync-cleared-at',
  'yh-sync-last-replay', 'yh-sync-last-replay-cursor', 'yh-sync-parent-lookup-after',
  'yh-sync-initial-pending', 'yh-sync-last-sync', 'yh-sync-known-ids', 'yh-sync-warn', 'yh-sync-error'
];
function businessTables(): Table[] {
  return [db.products, db.batches, db.orders, db.lines, db.adjustments, db.sessions, db.settings];
}

export interface RecoveryResult {
  /** 替换前成功落入独立备份库的安全快照。 */
  snapshot: SnapshotRow;
  generation: number;
  paused: true;
}

/**
 * 主库提交后清理跨存储状态；失败保留 marker，启动时再次调用即可继续。
 * marker 的读取、清理及删除共用 syncMeta 事务，避免旧清理删掉新恢复的标记。
 */
export async function completeRecoveryCleanup(): Promise<void> {
  await db.transaction('rw', db.syncMeta, async () => {
    if (!await pending.get(RECOVERY_PENDING_KEY)) return;
    // 无浏览器存储时也保留 marker，不能把尚未完成的清理当作成功。
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem('yh-sync-disabled', '1');
    for (const key of CLEANUP_KEYS) localStorage.removeItem(key);
    await pending.delete(RECOVERY_PENDING_KEY);
  });
}

async function captureCurrent(lease: SyncLease): Promise<BackupFile> {
  return db.transaction('r', [...businessTables(), db.syncMeta], async () => {
    await assertLeaseCurrent(lease);
    const [products, batches, orders, lines, adjustments, sessions, settings] = await Promise.all([
      db.products.toArray(), db.batches.toArray(), db.orders.toArray(), db.lines.toArray(),
      db.adjustments.toArray(), db.sessions.toArray(), db.settings.toArray()
    ]);
    return { app: 'yanhuo-erp', version: 2, exportedAt: new Date().toISOString(),
      deviceId: settings.find((row) => row.key === SETTING_KEYS.deviceId)?.value ?? '',
      data: { products, batches, orders, lines, adjustments, sessions, settings } };
  });
}

/** 恢复 / 撤销合并只替换本机数据；完成或失败均保持同步暂停。 */
export function restoreLocalBackup(file: BackupFile, reason = 'restore'): Promise<RecoveryResult> {
  return recoverLocal(() => file, reason);
}

/** 确认清空后保留设备与偏好设置，并重置业务初始化标记。 */
export function clearLocalSafely(lease?: SyncLease, completion?: { key: string; operationId: string }): Promise<RecoveryResult> {
  return recoverLocal((current) => ({
    ...current,
    data: { ...structuredClone(EMPTY_DATA), settings: [
      ...current.data.settings.filter((row) => row.key !== SETTING_KEYS.seeded && row.key !== SETTING_KEYS.sessionsMigrated),
      { key: SETTING_KEYS.seeded, value: '' }, { key: SETTING_KEYS.sessionsMigrated, value: '' }
    ] }
  }), 'clear-local', lease, completion);
}

function recoverLocal(replacement: (current: BackupFile) => BackupFile, reason: string, existingLease?: SyncLease,
  completion?: { key: string; operationId: string }): Promise<RecoveryResult> {
  const work = async (lease: SyncLease): Promise<RecoveryResult> => {
    // 独立 backupDb 无法与主库原子提交；先在维护期间保存快照，失败则不开始替换。
    // lazy import 必须在事务外，避免 merge → recovery → backup → merge 的静态循环。
    const { createSnapshot } = await import('./backup');
    const current = await captureCurrent(lease);
    const snapshot = await createSnapshot('pre-recovery', current);
    const file = replacement(current);
    await db.transaction('rw', [
      ...businessTables(), db.outbox, db.conflicts, db.remotePendingLines, db.remoteOrderUndo, db.syncMeta
    ], async () => {
      await assertLeaseCurrent(lease);
      const identity = (await db.settings.bulkGet(LOCAL_IDENTITY_KEYS)).filter((row): row is Setting => !!row);
      await Promise.all([
        ...businessTables().map((table) => table.clear()), db.outbox.clear(), db.conflicts.clear(),
        db.remotePendingLines.clear(), db.remoteOrderUndo.clear()
      ]);
      const data = file.data;
      await db.products.bulkPut(data.products ?? []);
      await db.batches.bulkPut(data.batches ?? []);
      await db.orders.bulkPut(data.orders ?? []);
      await db.lines.bulkPut(data.lines ?? []);
      await db.adjustments.bulkPut(data.adjustments ?? []);
      await db.sessions.bulkPut(data.sessions ?? []);
      const settings = new Map((data.settings ?? [])
        .filter((row) => row.key !== UNKNOWN_KINDS_KEY).map((row) => [row.key, row]));
      for (const row of identity) settings.set(row.key, row);
      await db.settings.bulkPut([...settings.values()]);
      await pending.put({ key: RECOVERY_PENDING_KEY, generation: lease.generation, token: crypto.randomUUID() });
      // 与本机替换原子提交；回执收尾失败后，同一次清空不再触及后来新记的数据。
      if (completion) await db.table<{ key: string; operationId: string }, string>('syncMeta').put(completion);
      await assertLeaseCurrent(lease);
    });
    await completeRecoveryCleanup();
    return { snapshot, generation: lease.generation, paused: true };
  };
  return existingLease ? work(existingLease) : runMaintenance(reason, work);
}
