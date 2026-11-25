// 导出 / 导入合并。
// 原则：订单按完整头部 + 明细清单成组比较；其他流水按 UUID 取并集；
//       商品和设置是可变数据，按 updatedAt / 导入优先。

import { db } from './db';
import { enqueueInTx, SKIP_SETTINGS, syncWanted, type OutboxItem } from './outbox';
import { canonicalJson } from './canonical';
import { fifoAllocate, sessionReport } from './calc';
import { restoreLocalBackup, type RecoveryResult } from './dataRecovery';
import { assertWritable } from './syncControl';
import type { AppData, Product, SaleLine, SalesOrder, Session } from './types';
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
  /** 新导出文件显式声明订单带完整 lineIds；旧文件缺失时按 legacy 处理。 */
  capabilities?: { completeOrderManifest: boolean };
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
    capabilities: { completeOrderManifest: true },
    data: { products, batches, orders, lines, adjustments, sessions, settings }
  };
}

export interface MergeResult {
  productsAdded: number;
  productsUpdated: number;
  productsKept: number;
  batchesAdded: number;
  ordersAdded: number;
  ordersUpdated: number;
  ordersKept: number;
  ordersConflicted: number;
  linesAdded: number;
  linesUpdated: number;
  linesRemoved: number;
  summariesUpdated: number;
  pendingLinesRemoved: number;
  conflictsCleared: number;
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
    ...(obj.capabilities?.completeOrderManifest === true ? { capabilities: { completeOrderManifest: true } } : {}),
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

export type OrderMergeChoice = 'local' | 'incoming';

export interface OrderMergeChange {
  orderId: string;
  label: string;
  action: 'added' | 'updated' | 'kept' | 'conflict';
  localTotalFen?: number;
  incomingTotalFen?: number;
  localLineCount: number;
  incomingLineCount: number;
  canChooseIncoming: boolean;
  selected: OrderMergeChoice;
  reason?: string;
}

export interface OrderMergePlanOptions {
  choices?: Record<string, OrderMergeChoice>;
  validProductIds?: ReadonlySet<string>;
}

interface OrderMergePlan {
  ordersToPut: SalesOrder[];
  linesToPut: SaleLine[];
  lineIdsToDelete: string[];
  linesForAddOnly: SaleLine[];
  ordersAdded: number;
  ordersUpdated: number;
  ordersKept: number;
  ordersConflicted: number;
  linesAdded: number;
  linesRemoved: number;
  changes: OrderMergeChange[];
}

function groupLinesByOrder(lines: SaleLine[]): Map<string, SaleLine[]> {
  const grouped = new Map<string, SaleLine[]>();
  for (const line of lines) {
    const group = grouped.get(line.orderId) ?? [];
    group.push(line);
    grouped.set(line.orderId, group);
  }
  return grouped;
}

function isCompleteOrderGroup(order: SalesOrder, lines: SaleLine[]): boolean {
  const manifest: unknown = order.lineIds;
  if (!Array.isArray(manifest) || manifest.some((id) => typeof id !== 'string' || id.length === 0)) return false;
  const ids = manifest as string[];
  const manifestSet = new Set(ids);
  if (manifestSet.size !== ids.length || lines.length !== ids.length || lines.some((line) => !manifestSet.has(line.id))) {
    return false;
  }
  const total = lines.reduce((sum, line) => sum + line.amountFen, 0);
  return lines.every((line) => Number.isFinite(line.amountFen)) &&
    Number.isFinite(order.totalFen) && total === order.totalFen;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function validateModernOrderGroup(
  order: SalesOrder,
  lines: SaleLine[],
  incomingLineCounts: Map<string, number>,
  incomingLineById: Map<string, SaleLine>,
  validProductIds?: ReadonlySet<string>
): void {
  const manifest = order.lineIds as string[];
  if (manifest.length === 0) throw new Error(`订单 ${order.id} 的明细清单不能为空`);
  if (!validTimestamp(order.createdAt) || (order.updatedAt !== undefined && !validTimestamp(order.updatedAt))) {
    throw new Error(`订单 ${order.id} 的时间格式无效`);
  }
  if (!Number.isSafeInteger(order.totalFen) || order.totalFen < 0) {
    throw new Error(`订单 ${order.id} 的金额无效`);
  }
  for (const line of lines) {
    if (!validTimestamp(line.updatedAt ?? order.createdAt)) throw new Error(`订单 ${order.id} 的明细时间无效`);
    if (!Number.isSafeInteger(line.qtyBase) || line.qtyBase <= 0 ||
      !Number.isSafeInteger(line.qty) || line.qty <= 0) {
      throw new Error(`订单 ${order.id} 的明细数量无效`);
    }
    if (!Number.isSafeInteger(line.amountFen) || line.amountFen < 0) {
      throw new Error(`订单 ${order.id} 的明细金额无效`);
    }
    if (validProductIds && !validProductIds.has(line.productId)) {
      throw new Error(`订单 ${order.id} 引用了备份中不存在的商品`);
    }
  }
  if (manifest.some((id) => incomingLineCounts.get(id) !== 1 || incomingLineById.get(id)?.orderId !== order.id)) {
    throw new Error(`订单 ${order.id} 的明细 ID 重复或归属错误`);
  }
}

function orderGroupSignature(order: SalesOrder, lines: SaleLine[]): string {
  const ids = [...(order.lineIds ?? [])].sort();
  const sortedLines = [...lines].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return canonicalJson({ order: { ...order, lineIds: ids }, lines: sortedLines });
}

export function planOrderMerge(
  existingOrders: SalesOrder[],
  existingLines: SaleLine[],
  incomingOrders: SalesOrder[],
  incomingLines: SaleLine[],
  options: OrderMergePlanOptions = {}
): OrderMergePlan {
  const choices = options.choices ?? {};
  const incomingOrderIds = new Set<string>();
  for (const order of incomingOrders) {
    if (incomingOrderIds.has(order.id)) throw new Error(`备份包含重复订单：${order.id}`);
    incomingOrderIds.add(order.id);
  }

  const incomingLinesByOrder = groupLinesByOrder(incomingLines);
  const incomingLineCounts = new Map<string, number>();
  const incomingLineById = new Map<string, SaleLine>();
  for (const line of incomingLines) {
    incomingLineCounts.set(line.id, (incomingLineCounts.get(line.id) ?? 0) + 1);
    if (incomingLineCounts.get(line.id)! > 1) throw new Error(`备份包含重复明细：${line.id}`);
    incomingLineById.set(line.id, line);
  }

  for (const order of incomingOrders) {
    const manifest: unknown = order.lineIds;
    if (manifest === undefined) continue;
    if (!Array.isArray(manifest) || manifest.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new Error(`订单 ${order.id} 的明细清单格式无效`);
    }
    const ids = manifest as string[];
    const idSet = new Set(ids);
    const rows = incomingLinesByOrder.get(order.id) ?? [];
    if (idSet.size !== ids.length || rows.length !== ids.length || rows.some((line) => !idSet.has(line.id))) {
      throw new Error(`订单 ${order.id} 的明细清单与备份明细不一致`);
    }
    validateModernOrderGroup(order, rows, incomingLineCounts, incomingLineById, options.validProductIds);
    const total = rows.reduce((sum, line) => sum + line.amountFen, 0);
    if (total !== order.totalFen) {
      throw new Error(`订单 ${order.id} 的金额与明细合计不一致`);
    }
  }

  const existingOrderById = new Map(existingOrders.map((order) => [order.id, order]));
  for (const line of incomingLines) {
    if (!incomingOrderIds.has(line.orderId) && !existingOrderById.has(line.orderId)) {
      throw new Error(`备份明细 ${line.id} 找不到父单订单`);
    }
  }
  const existingLinesByOrder = groupLinesByOrder(existingLines);
  const existingLineById = new Map(existingLines.map((line) => [line.id, line]));
  const plan: OrderMergePlan = {
    ordersToPut: [], linesToPut: [], lineIdsToDelete: [], linesForAddOnly: [],
    ordersAdded: 0, ordersUpdated: 0, ordersKept: 0, ordersConflicted: 0,
    linesAdded: 0, linesRemoved: 0, changes: []
  };
  const conflictedOrders = new Set<string>();
  const markConflict = (orderId: string) => {
    if (conflictedOrders.has(orderId)) return;
    conflictedOrders.add(orderId);
    plan.ordersConflicted++;
  };
  const legacyNewOrderIds = new Set<string>();

  for (const [orderId, choice] of Object.entries(choices)) {
    if (!incomingOrderIds.has(orderId)) throw new Error(`订单选择引用了备份中不存在的订单：${orderId}`);
    if (choice !== 'local' && choice !== 'incoming') throw new Error(`订单 ${orderId} 的选择无效`);
  }

  for (const incoming of incomingOrders) {
    const current = existingOrderById.get(incoming.id);
    const manifest: unknown = incoming.lineIds;
    const incomingGroup = incomingLinesByOrder.get(incoming.id) ?? [];
    const currentGroup = existingLinesByOrder.get(incoming.id) ?? [];
    const choice = choices[incoming.id] ?? 'local';
    const label = `${incoming.createdAt} · ${incoming.totalFen}分`;
    const baseChange = {
      orderId: incoming.id,
      label,
      localTotalFen: current?.totalFen,
      incomingTotalFen: incoming.totalFen,
      localLineCount: currentGroup.length,
      incomingLineCount: incomingGroup.length,
      canChooseIncoming: false,
      selected: choice
    } as const;

    if (manifest === undefined) {
      if (current) {
        markConflict(incoming.id);
        plan.changes.push({ ...baseChange, action: 'conflict', reason: '旧格式订单缺少完整明细清单' });
      } else {
        plan.ordersToPut.push(incoming);
        plan.ordersAdded++;
        legacyNewOrderIds.add(incoming.id);
        plan.changes.push({ ...baseChange, action: 'added', selected: 'incoming' });
      }
      continue;
    }

    const hasForeignLineId = incomingGroup.some((line) => {
      const existing = existingLineById.get(line.id);
      return existing !== undefined && existing.orderId !== incoming.id;
    });
    if (hasForeignLineId) {
      markConflict(incoming.id);
      plan.changes.push({ ...baseChange, action: 'conflict', reason: '备份明细 ID 与本机其他订单冲突' });
      continue;
    }

    if (!current) {
      const incomingIds = new Set(incoming.lineIds as string[]);
      const orphanLines = currentGroup.filter((line) => !incomingIds.has(line.id));
      if (orphanLines.length > 0 && choice !== 'incoming') {
        markConflict(incoming.id);
        plan.changes.push({ ...baseChange, action: 'conflict', canChooseIncoming: true,
          reason: '本机有同编号孤儿明细，默认保留现场' });
        continue;
      }
      plan.ordersToPut.push(incoming);
      plan.linesToPut.push(...incomingGroup);
      plan.lineIdsToDelete.push(...orphanLines.map((line) => line.id));
      plan.ordersAdded++;
      plan.linesAdded += incomingGroup.filter((line) => !existingLineById.has(line.id)).length;
      plan.linesRemoved += orphanLines.length;
      plan.changes.push({ ...baseChange, action: 'added', selected: 'incoming' });
      continue;
    }

    if (isCompleteOrderGroup(current, currentGroup) &&
      orderGroupSignature(current, currentGroup) === orderGroupSignature(incoming, incomingGroup)) {
      plan.ordersKept++;
      plan.changes.push({ ...baseChange, action: 'kept' });
      continue;
    }

    if (choice !== 'incoming') {
      markConflict(incoming.id);
      plan.changes.push({ ...baseChange, action: 'conflict', canChooseIncoming: true,
        reason: '同编号订单内容不同，默认保留本机' });
      continue;
    }

    const incomingIds = new Set(incoming.lineIds as string[]);
    const removed = currentGroup.filter((line) => !incomingIds.has(line.id));
    plan.ordersToPut.push(incoming);
    plan.linesToPut.push(...incomingGroup);
    plan.lineIdsToDelete.push(...removed.map((line) => line.id));
    plan.ordersUpdated++;
    plan.linesAdded += incomingGroup.filter((line) => !existingLineById.has(line.id)).length;
    plan.linesRemoved += removed.length;
    plan.changes.push({ ...baseChange, action: 'updated', selected: 'incoming' });
  }

  for (const line of incomingLines) {
    if (incomingOrderIds.has(line.orderId)) {
      if (legacyNewOrderIds.has(line.orderId)) plan.linesForAddOnly.push(line);
      continue;
    }
    if (existingOrderById.has(line.orderId)) {
      markConflict(line.orderId);
      continue;
    }
    plan.linesForAddOnly.push(line);
  }
  return plan;
}

export interface ImportMergeOptions {
  orderChoices?: Record<string, OrderMergeChoice>;
  undoSnapshotId?: number;
  expectedLocalFingerprint?: string;
}

export function localDataFingerprint(data: AppData): string {
  return canonicalJson({
    products: data.products,
    batches: data.batches,
    orders: data.orders,
    lines: data.lines,
    adjustments: data.adjustments,
    sessions: data.sessions,
    settings: data.settings
  });
}

/** 合并备份；订单按完整组决策，其他流水保持既有合并语义。 */
export async function importMerge(backup: BackupFile, options: ImportMergeOptions = {}): Promise<MergeResult> {
  const data = backup.data;
  const result: MergeResult = {
    productsAdded: 0,
    productsUpdated: 0,
    productsKept: 0,
    batchesAdded: 0,
    ordersAdded: 0,
    ordersUpdated: 0,
    ordersKept: 0,
    ordersConflicted: 0,
    linesAdded: 0,
    linesUpdated: 0,
    linesRemoved: 0,
    summariesUpdated: 0,
    pendingLinesRemoved: 0,
    conflictsCleared: 0,
    adjustmentsAdded: 0,
    sessionsAdded: 0,
    sessionsUpdated: 0,
    settingsImported: 0
  };

  await assertWritable();
  await db.transaction(
    'rw',
    [db.products, db.batches, db.orders, db.lines, db.adjustments, db.sessions, db.settings,
      db.outbox, db.conflicts, db.remotePendingLines, db.remoteOrderUndo, db.syncMeta],
    async () => {
      await assertWritable();
      const changed: OutboxItem[] = [];
      const currentData: AppData = {
        products: await db.products.toArray(),
        batches: await db.batches.toArray(),
        orders: await db.orders.toArray(),
        lines: await db.lines.toArray(),
        adjustments: await db.adjustments.toArray(),
        sessions: await db.sessions.toArray(),
        settings: await db.settings.toArray()
      };
      if (options.expectedLocalFingerprint !== undefined &&
        localDataFingerprint(currentData) !== options.expectedLocalFingerprint) {
        throw new Error('本机数据在预览后已变化，请重新选择文件并预览');
      }
      const validProductIds = new Set([
        ...currentData.products.map((product) => product.id),
        ...(data.products ?? []).map((product) => product.id)
      ]);
      const orderPlan = planOrderMerge(
        currentData.orders, currentData.lines, data.orders ?? [], data.lines ?? [],
        { choices: options.orderChoices, validProductIds }
      );
      const existingLineById = new Map(currentData.lines.map((line) => [line.id, line]));
      result.linesUpdated = orderPlan.linesToPut.filter((line) => {
        const current = existingLineById.get(line.id);
        return current !== undefined && canonicalJson(current) !== canonicalJson(line);
      }).length;
      result.ordersAdded = orderPlan.ordersAdded;
      result.ordersUpdated = orderPlan.ordersUpdated;
      result.ordersKept = orderPlan.ordersKept;
      result.ordersConflicted = orderPlan.ordersConflicted;
      result.linesAdded = orderPlan.linesAdded;
      result.linesRemoved = orderPlan.linesRemoved;

      const affectedOrderIds = [...new Set((data.orders ?? []).map((order) => order.id))];
      const pendingRows = affectedOrderIds.length > 0
        ? await db.remotePendingLines.where('orderId').anyOf(affectedOrderIds).toArray()
        : [];
      const selectedLineIds = new Set([
        ...orderPlan.linesToPut.map((line) => line.id),
        ...orderPlan.linesForAddOnly.map((line) => line.id)
      ]);
      const pendingLineDeletes = pendingRows
        .filter((row) => !selectedLineIds.has(row.id))
        .map((row) => row.id);
      result.pendingLinesRemoved = pendingRows.length;
      if (affectedOrderIds.length > 0) {
        await db.remotePendingLines.where('orderId').anyOf(affectedOrderIds).delete();
        await db.remoteOrderUndo.where('orderId').anyOf(affectedOrderIds).delete();
      }

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

      // 订单以完整组决策；非订单流水继续按 id 只增。
      const batches = await addOnly(db.batches, data.batches ?? []);
      if (orderPlan.ordersToPut.length) await db.orders.bulkPut(orderPlan.ordersToPut);
      if (orderPlan.lineIdsToDelete.length) await db.lines.bulkDelete(orderPlan.lineIdsToDelete);
      if (orderPlan.linesToPut.length) await db.lines.bulkPut(orderPlan.linesToPut);
      const legacyLines = await addOnly(db.lines, orderPlan.linesForAddOnly);
      const adjustments = await addOnly(db.adjustments, data.adjustments ?? []);
      result.batchesAdded = batches.length;
      result.linesAdded += legacyLines.length;
      result.adjustmentsAdded = adjustments.length;
      changed.push(
        ...batches.map((row) => ({ kind: 'batch' as const, recordId: row.id })),
        ...orderPlan.ordersToPut.map((row) => ({ kind: 'order' as const, recordId: row.id })),
        ...orderPlan.lineIdsToDelete.map((recordId) => ({ kind: 'line' as const, recordId, op: 'delete' as const })),
        ...pendingLineDeletes.map((recordId) => ({ kind: 'line' as const, recordId, op: 'delete' as const })),
        ...orderPlan.linesToPut.map((row) => ({ kind: 'line' as const, recordId: row.id })),
        ...legacyLines.map((row) => ({ kind: 'line' as const, recordId: row.id })),
        ...adjustments.map((row) => ({ kind: 'adjustment' as const, recordId: row.id }))
      );

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

      const metadata = [
        { key: SETTING_KEYS.lastImportAt, value: nowIso() },
        ...(options.undoSnapshotId !== undefined
          ? [{ key: SETTING_KEYS.mergeUndoSnapshotId, value: String(options.undoSnapshotId) }]
          : [])
      ];
      if (metadata.length > 0) {
        await db.settings.bulkPut(metadata);
        changed.push({ kind: 'setting', recordId: SETTING_KEYS.lastImportAt });
      }

      // 手动合并不频繁：用最终订单/明细/批次一次 FIFO 重放，重算所有已结账快照，
      // 避免新增批次只影响成本、却漏改首页仍读取的 session.summary。
      const finalOrders = await db.orders.toArray();
      const finalLines = await db.lines.toArray();
      const finalBatches = await db.batches.toArray();
      const finalSessions = await db.sessions.toArray();
      const closedSessions = finalSessions.filter((session) => session.status === 'closed');
      if (closedSessions.length > 0) {
        const fifo = fifoAllocate(finalBatches, finalOrders, finalLines);
        const at = nowIso();
        const summaryUpdates: Session[] = [];
        for (const session of closedSessions) {
          const summary = sessionReport(session.id, finalOrders, finalLines, fifo);
          if (canonicalJson(summary) === canonicalJson(session.summary)) continue;
          summaryUpdates.push({ ...session, summary, updatedAt: at });
        }
        if (summaryUpdates.length > 0) {
          await db.sessions.bulkPut(summaryUpdates);
          result.summariesUpdated = summaryUpdates.length;
          changed.push(...summaryUpdates.map((row) => ({ kind: 'session' as const, recordId: row.id })));
        }
      }

      const conflictKeys = [...new Map(changed.map((item) => [
        `${item.kind}:${item.recordId}`, [item.kind, item.recordId] as [string, string]
      ])).values()];
      if (conflictKeys.length > 0) {
        result.conflictsCleared = await db.conflicts.where('[kind+recordId]').anyOf(conflictKeys).delete();
      }
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