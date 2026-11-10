// 导出 / 导入合并。
// 原则：流水表（进货/销售/明细/调整）只增不改，按 UUID 取并集；
//       商品和设置是可变数据，按 updatedAt / 导入优先。

import { db } from './db';
import type { AppData, Product, Session } from './types';
import { SETTING_KEYS } from './types';
import { mergeSessionPair } from './sessionLogic';
import { nowIso } from './util';
import type { Table } from 'dexie';

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

/** 流水只增：按 id 取差集写入，返回实际新增条数 */
async function addOnly<T extends { id: string }>(
  table: Table<T, string>,
  incoming: T[]
): Promise<number> {
  const existing = new Set((await table.toArray()).map((x) => x.id));
  const fresh = incoming.filter((x) => !existing.has(x.id));
  if (fresh.length > 0) await table.bulkPut(fresh);
  return fresh.length;
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

  await db.transaction(
    'rw',
    [db.products, db.batches, db.orders, db.lines, db.adjustments, db.sessions, db.settings],
    async () => {
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

      // 流水：只增
      result.batchesAdded = await addOnly(db.batches, data.batches);
      result.ordersAdded = await addOnly(db.orders, data.orders);
      result.linesAdded = await addOnly(db.lines, data.lines);
      result.adjustmentsAdded = await addOnly(db.adjustments, data.adjustments);

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
        toPutSessions.push(merged);
        result.sessionsUpdated++;
      }
      if (toPutSessions.length) await db.sessions.bulkPut(toPutSessions);

      // 设置：本机身份与操作人不覆盖（操作人按设备走）
      const skip = new Set<string>([
        SETTING_KEYS.deviceId,
        SETTING_KEYS.deviceName,
        SETTING_KEYS.operatorA,
        SETTING_KEYS.operatorB
      ]);
      const incoming = data.settings.filter((s) => !skip.has(s.key));
      if (incoming.length) {
        await db.settings.bulkPut(incoming);
        result.settingsImported = incoming.length;
      }
    }
  );

  return result;
}

/** 整库替换（撤销合并用）：清空后写入给定备份 */
export async function replaceAll(backup: BackupFile): Promise<void> {
  const d = backup.data;
  await db.transaction(
    'rw',
    [db.products, db.batches, db.orders, db.lines, db.adjustments, db.sessions, db.settings],
    async () => {
      await Promise.all([
        db.products.clear(),
        db.batches.clear(),
        db.orders.clear(),
        db.lines.clear(),
        db.adjustments.clear(),
        db.sessions.clear(),
        db.settings.clear()
      ]);
      await db.products.bulkPut(d.products);
      await db.batches.bulkPut(d.batches);
      await db.orders.bulkPut(d.orders);
      await db.lines.bulkPut(d.lines);
      await db.adjustments.bulkPut(d.adjustments);
      await db.sessions.bulkPut(d.sessions ?? []);
      await db.settings.bulkPut(d.settings);
    }
  );
}