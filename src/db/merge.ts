// 导出 / 导入合并。
// 原则：流水表（进货/销售/明细/调整）只增不改，按 UUID 取并集；
//       商品和设置是可变数据，按 updatedAt / 导入优先。

import { db } from './db';
import { enqueueInTx, SKIP_SETTINGS, syncWanted, type OutboxItem } from './outbox';
import { canonicalJson } from './canonical';
import { restoreLocalBackup, type RecoveryResult } from './dataRecovery';
import { assertWritable } from './syncControl';
import type { AppData, Product, Session } from './types';
import { SETTING_KEYS } from './types';
import { mergeSessionPair } from './sessionLogic';
import { nowIso } from './util';
import type { Table } from 'dexie';

/**
 * 本机身份键：导入 / 整库替换都**不允许**被外部数据覆盖。
 *
 * `deviceId` 一变，本机进行中的场次立刻按 deviceId 过滤不到（「这场找不到了」）；
 * `operatorSelf` 被备份覆盖后，本机新单会记到另一台手机的操作人名下（M-2）。
 * `operatorA/B` 只为兼容老备份里的默认值（'我'/'老婆'），同样不覆盖。
 */
const LOCAL_IDENTITY_KEYS: string[] = [
  SETTING_KEYS.deviceId,
  SETTING_KEYS.deviceName,
  SETTING_KEYS.operatorA,
  SETTING_KEYS.operatorB,
  SETTING_KEYS.operatorSelf
];

export interface BackupFile {
  app: 'yanhuo-erp';
  /** 1 = 实时收银；2 = 场次记账（多了 sessions） */
  version: 1 | 2;
  exportedAt: string;
  deviceId: string;
  data: AppData;
}

export async function exportBackup(deviceId: string): Promise<BackupFile> {
  const [products, batches, orders, lines, adjustments, sessions, settings] = await Promise.all([
    db.products.toArray(),
    db.batches.toArray(),
    db.orders.toArray(),
    db.lines.toArray(),
    db.adjustments.toArray(),
    db.sessions.toArray(),
    db.settings.toArray()
  ]);
  return {
    app: 'yanhuo-erp',
    version: 2,
    exportedAt: nowIso(),
    deviceId,
    data: { products, batches, orders, lines, adjustments, sessions, settings }
  };
}

export interface MergeResult {
  productsAdded: number;
  productsUpdated: number;
  productsKept: number;
  batchesAdded: number;
  ordersAdded: number;
  linesAdded: number;
  adjustmentsAdded: number;
  sessionsAdded: number;
  sessionsUpdated: number;
  settingsImported: number;
}

export function parseBackup(text: string): BackupFile {
  const obj = JSON.parse(text) as Partial<BackupFile>;
  if (!obj || obj.app !== 'yanhuo-erp' || !obj.data) {
    throw new Error('不是本工具导出的备份文件');
  }
  const d = obj.data;
  if (!Array.isArray(d.products) || !Array.isArray(d.orders)) {
    throw new Error('备份文件结构不完整');
  }
  return {
    app: 'yanhuo-erp',
    version: obj.version === 2 ? 2 : 1,
    exportedAt: obj.exportedAt ?? nowIso(),
    deviceId: obj.deviceId ?? '',
    data: {
      products: d.products ?? [],
      batches: d.batches ?? [],
      orders: d.orders ?? [],
      lines: d.lines ?? [],
      adjustments: d.adjustments ?? [],
      sessions: d.sessions ?? [],
      settings: d.settings ?? []
    }
  };
}

/** 流水只增：按 id 取差集写入，返回实际新增行供同事务入队。 */
async function addOnly<T extends { id: string }>(
  table: Table<T, string>,
  incoming: T[]
): Promise<T[]> {
  const existing = new Set((await table.toArray()).map((x) => x.id));
  const fresh: T[] = [];
  for (const row of incoming) {
    if (existing.has(row.id)) continue;
    existing.add(row.id);
    fresh.push(row);
  }
  if (fresh.length > 0) await table.bulkPut(fresh);
  return fresh;
}

/** 合并备份；同 id 的流水直接跳过，商品按 updatedAt 新者胜 */
export async function importMerge(backup: BackupFile): Promise<MergeResult> {
  const data = backup.data;
  const result: MergeResult = {
    productsAdded: 0,
    productsUpdated: 0,
    productsKept: 0,
    batchesAdded: 0,
    ordersAdded: 0,
    linesAdded: 0,
    adjustmentsAdded: 0,
    sessionsAdded: 0,
    sessionsUpdated: 0,
    settingsImported: 0
  };

  await assertWritable();
  await db.transaction(
    'rw',
    [db.products, db.batches, db.orders, db.lines, db.adjustments, db.sessions, db.settings, db.outbox, db.syncMeta],
    async () => {
      await assertWritable();
      const changed: OutboxItem[] = [];
      // 商品：id 不存在则新增；存在则比 updatedAt
      const existingProducts = await db.products.bulkGet(data.products.map((p) => p.id));
      const toPutProducts: Product[] = [];
      for (let i = 0; i < data.products.length; i++) {
        const inc = data.products[i];
        const cur = existingProducts[i];
        if (!cur) {
          toPutProducts.push(inc);
          result.productsAdded++;
        } else if ((inc.updatedAt ?? '') > (cur.updatedAt ?? '')) {
          toPutProducts.push(inc);
          result.productsUpdated++;
        } else {
          result.productsKept++;
        }
      }
      if (toPutProducts.length) await db.products.bulkPut(toPutProducts);
      changed.push(...toPutProducts.map((row) => ({ kind: 'product' as const, recordId: row.id })));

      // 流水：只增，只登记本次实际新增的行。
      const batches = await addOnly(db.batches, data.batches ?? []);
      const orders = await addOnly(db.orders, data.orders ?? []);
      const lines = await addOnly(db.lines, data.lines ?? []);
      const adjustments = await addOnly(db.adjustments, data.adjustments ?? []);
      result.batchesAdded = batches.length;
      result.ordersAdded = orders.length;
      result.linesAdded = lines.length;
      result.adjustmentsAdded = adjustments.length;
      changed.push(...batches.map((row) => ({ kind: 'batch' as const, recordId: row.id })),
        ...orders.map((row) => ({ kind: 'order' as const, recordId: row.id })),
        ...lines.map((row) => ({ kind: 'line' as const, recordId: row.id })),
        ...adjustments.map((row) => ({ kind: 'adjustment' as const, recordId: row.id })));

      // 场次：同 id 合并；closed 优先，其次 updatedAt 新者胜；补记计数取 max
      const incomingSessions = data.sessions ?? [];
      const existingSessions = await db.sessions.bulkGet(incomingSessions.map((s) => s.id));
      const toPutSessions: Session[] = [];
      for (let i = 0; i < incomingSessions.length; i++) {
        const inc = incomingSessions[i];
        const cur = existingSessions[i];
        if (!cur) {
          toPutSessions.push(inc);
          result.sessionsAdded++;
          continue;
        }
        const merged = mergeSessionPair(cur, inc);
        if (canonicalJson(merged) !== canonicalJson(cur)) {
          toPutSessions.push(merged);
          result.sessionsUpdated++;
        }
      }
      if (toPutSessions.length) await db.sessions.bulkPut(toPutSessions);
      changed.push(...toPutSessions.map((row) => ({ kind: 'session' as const, recordId: row.id })));

      // 设置沿用本机身份保护，并与发件箱的本机诊断过滤规则一致。
      const skip = new Set<string>([...LOCAL_IDENTITY_KEYS, ...SKIP_SETTINGS]);
      const incoming = (data.settings ?? []).filter((row) => !skip.has(row.key));
      const existingSettings = await db.settings.bulkGet(incoming.map((row) => row.key));
      const settings = incoming.filter((row, index) => existingSettings[index]?.value !== row.value);
      if (settings.length) {
        await db.settings.bulkPut(settings);
        result.settingsImported = settings.length;
      }
      changed.push(...settings.map((row) => ({ kind: 'setting' as const, recordId: row.key })));
      await enqueueInTx(changed);
    }
  );

  syncWanted();

  return result;
}

/** 撤销合并沿用统一的本机恢复边界，提交后继续暂停同步。 */
export function replaceAll(backup: BackupFile): Promise<RecoveryResult> {
  return restoreLocalBackup(backup);
}