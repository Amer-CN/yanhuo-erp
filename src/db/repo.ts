// 数据读写：商品、进货、开单、调整、设置。全部走 Dexie。

import { db } from './db';
import type {
  Adjustment,
  AdjustType,
  AppData,
  Batch,
  Category,
  PayMethod,
  Product,
  SaleLine,
  SalesOrder,
  Session,
  SessionSummary,
  Setting
} from './types';
import { SETTING_KEYS, SESSIONS_MIGRATED_VALUE } from './types';
import { fifoAllocate, sessionReport } from './calc';
import { groupOrdersBySession } from './sessionLogic';
import { localDate, nowIso, uuid } from './util';
import { enqueue, enqueueMany } from './outbox';

/* ------------------------------------------------------------------ 设置 */

export async function getSetting(key: string): Promise<string | undefined> {
  return (await db.settings.get(key))?.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db.settings.put({ key, value });
  await enqueue('setting', key);
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await db.settings.toArray();
  const o: Record<string, string> = {};
  for (const r of rows) o[r.key] = r.value;
  return o;
}

/** 保证本机有一个稳定的 deviceId（事务内检查，避免 StrictMode 双执行重复生成） */
export async function ensureDeviceId(): Promise<string> {
  return db.transaction('rw', db.settings, async () => {
    const existing = await db.settings.get(SETTING_KEYS.deviceId);
    if (existing?.value) return existing.value;
    const id = uuid();
    await db.settings.put({ key: SETTING_KEYS.deviceId, value: id });
    return id;
  });
}

/**
 * 启动期默认设置：一次读取、一次批量写入，避免启动链上多个串行 IDB 往返。
 * 仍按 setSetting 的语义把新写入的 key 登记到发件箱，同步行为不变。
 */
export async function ensureBootstrapSettings(defaults: Record<string, string>): Promise<void> {
  const keys = Object.keys(defaults);
  const rows = await db.settings.toArray();
  const present = new Map(rows.map((r) => [r.key, r.value]));
  // 只看 key 是否存在：clearAllData 会把值置空，空串仍是「已初始化」
  const missing = keys.filter((k) => !present.has(k));
  if (missing.length === 0) return;
  await db.settings.bulkPut(missing.map((k) => ({ key: k, value: defaults[k] })));
  await enqueueMany(missing.map((k) => ({ kind: 'setting' as const, recordId: k })));
}

/* ------------------------------------------------------------------ 商品 */

export interface ProductInput {
  name: string;
  category: Category;
  unitBase: string;
  boxQty: number;
  priceList: number;
  negotiable: boolean;
  sortOrder?: number;
}

export async function createProduct(input: ProductInput): Promise<Product> {
  const t = nowIso();
  const p: Product = {
    id: uuid(),
    name: input.name.trim(),
    category: input.category,
    unitBase: input.unitBase.trim() || '个',
    boxQty: Math.max(0, Math.floor(input.boxQty)),
    priceList: Math.max(0, Math.round(input.priceList)),
    negotiable: input.negotiable,
    archived: false,
    sortOrder: input.sortOrder ?? Date.now(),
    createdAt: t,
    updatedAt: t
  };
  await db.products.put(p);
  await enqueue('product', p.id);
  return p;
}

export async function updateProduct(id: string, patch: Partial<ProductInput> & { archived?: boolean }): Promise<void> {
  const old = await db.products.get(id);
  if (!old) return;
  const next: Product = { ...old, ...patch, updatedAt: nowIso() } as Product;
  // 用户动过商品内容，就不再算示例
  const touched = ['name', 'category', 'unitBase', 'boxQty', 'priceList', 'negotiable'].some(
    (k) => (patch as Record<string, unknown>)[k] !== undefined
  );
  if (touched) next.sample = false;
  if (patch.name !== undefined) next.name = patch.name.trim();
  if (patch.unitBase !== undefined) next.unitBase = patch.unitBase.trim() || '个';
  if (patch.boxQty !== undefined) next.boxQty = Math.max(0, Math.floor(patch.boxQty));
  if (patch.priceList !== undefined) next.priceList = Math.max(0, Math.round(patch.priceList));
  await db.products.put(next);
  await enqueue('product', id);
}

export async function deleteProduct(id: string): Promise<void> {
  // 有流水的商品不能删，只能停用
  const used =
    (await db.batches.where('productId').equals(id).count()) +
    (await db.lines.where('productId').equals(id).count()) +
    (await db.adjustments.where('productId').equals(id).count());
  if (used > 0) {
    await updateProduct(id, { archived: true });
    return;
  }
  await db.products.delete(id);
  await enqueue('product', id, 'delete');
}

/* ------------------------------------------------------------------ 进货 */

export interface BatchInput {
  productId: string;
  batchNo?: string;
  produceDate?: string;
  expiryDate?: string;
  qtyBase: number;
  unitCostFen: number;
  supplier?: string;
  receivedAt?: string;
}

export async function createBatch(input: BatchInput, deviceId: string): Promise<Batch> {
  const createdAt = nowIso();
  const b: Batch = {
    id: uuid(),
    productId: input.productId,
    batchNo: input.batchNo?.trim() || undefined,
    produceDate: input.produceDate || undefined,
    expiryDate: input.expiryDate || undefined,
    qtyBase: Math.floor(input.qtyBase),
    unitCostFen: Math.max(0, Math.round(input.unitCostFen)),
    supplier: input.supplier?.trim() || undefined,
    receivedAt: input.receivedAt || localDate(),
    deviceId,
    createdAt,
    updatedAt: createdAt
  };
  await db.batches.put(b);
  await enqueue('batch', b.id);
  return b;
}

export async function deleteBatch(id: string): Promise<void> {
  await db.batches.delete(id);
  await enqueue('batch', id, 'delete');
}

/* ------------------------------------------------------------------ 场次 */

export type RecordErrorCode =
  | 'EMPTY_LINES'
  | 'INVALID_QTY'
  | 'INVALID_AMOUNT'
  | 'ZERO_AMOUNT_NOT_GIFT'
  | 'SESSION_CLOSED'
  | 'SESSION_NOT_FOUND'
  | 'ALREADY_CLOSED'
  | 'NOT_CLOSED'
  | 'NEXT_SESSION_STARTED';

export class RecordError extends Error {
  code: RecordErrorCode;
  constructor(code: RecordErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'RecordError';
    this.code = code;
  }
}

/** 找不到场次时的统一提示（'这单找不到…' 是另一种文案，不要合并） */
const SESSION_GONE_MSG = '这场找不到了，刷新看看';

/** 本机正在进行中的场次（异常情况下有多条时取最晚开始的一场） */
export async function getOpenSession(deviceId: string): Promise<Session | undefined> {
  const rows = await db.sessions.where('status').equals('open').toArray();
  return rows
    .filter((s) => s.deviceId === deviceId)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
}

/** 取本机 open 场次；没有就开一场（第一笔记账时调用） */
export async function ensureOpenSession(deviceId: string, operator: string): Promise<Session> {
  const existing = await getOpenSession(deviceId);
  if (existing) return existing;

  const now = nowIso();
  const session: Session = {
    id: uuid(),
    deviceId,
    startedAt: now,
    status: 'open',
    openedBy: operator,
    patchedCount: 0,
    updatedAt: now
  };
  await db.sessions.put(session);
  await enqueue('session', session.id);
  return session;
}

export async function getSession(id: string): Promise<Session | undefined> {
  return db.sessions.get(id);
}

/** 本机最近一场（含已结账） */
export async function getLastSession(deviceId: string): Promise<Session | undefined> {
  const rows = await db.sessions.where('deviceId').equals(deviceId).toArray();
  return rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
}

interface LedgerTables {
  orders: SalesOrder[];
  lines: SaleLine[];
  batches: Batch[];
}

/** 一次读出重算快照所需的三张全表（与各调用点改动前的读取集合一致） */
async function loadLedger(): Promise<LedgerTables> {
  const [orders, lines, batches] = await Promise.all([
    db.orders.toArray(),
    db.lines.toArray(),
    db.batches.toArray()
  ]);
  return { orders, lines, batches };
}

/** 用给定集合重算某场次快照：FIFO 在内部完成，不对外暴露 FifoResult */
function summarize(
  sessionId: string,
  orders: SalesOrder[],
  lines: SaleLine[],
  batches: Batch[]
): SessionSummary {
  return sessionReport(sessionId, orders, lines, fifoAllocate(batches, orders, lines));
}

/* ------------------------------------------------------------------ 单据 */

export interface RecordLineInput {
  productId: string;
  qtyBase: number;
  unit: 'box' | 'base';
  qty: number;
  listUnitPriceFen: number;
  /** 展示用；以 amountFen 为准，repo 内会重算 */
  unitPriceFen: number;
  amountFen: number;
  gift?: boolean;
}

export interface RecordInput {
  deviceId: string;
  operator: string;
  payMethod: PayMethod;
  /** 补记到已结账场次时传；正常记账不传 */
  sessionId?: string;
  note?: string;
  lines: RecordLineInput[];
}

function buildLines(orderId: string, input: RecordLineInput[], updatedAt: string = nowIso()): SaleLine[] {
  if (input.length === 0) throw new RecordError('EMPTY_LINES', '先加一个商品');
  return input.map((l) => {
    const qtyBase = Math.round(l.qtyBase);
    if (!Number.isFinite(qtyBase) || qtyBase <= 0) {
      throw new RecordError('INVALID_QTY', '数量要大于 0');
    }
    if (!Number.isFinite(l.amountFen) || l.amountFen < 0) {
      throw new RecordError('INVALID_AMOUNT', '成交金额填个数字');
    }
    const gift = Boolean(l.gift);
    if (!gift && Math.round(l.amountFen) === 0) {
      throw new RecordError('ZERO_AMOUNT_NOT_GIFT', '0 元，是赠品吗？');
    }
    const amountFen = gift ? 0 : Math.round(l.amountFen);
    const listAmount = Math.max(0, Math.round(l.listUnitPriceFen)) * qtyBase;
    return {
      id: uuid(),
      orderId,
      productId: l.productId,
      qtyBase,
      unit: l.unit,
      qty: Number.isFinite(l.qty) && l.qty > 0 ? Math.round(l.qty) : qtyBase,
      listUnitPriceFen: Math.max(0, Math.round(l.listUnitPriceFen)),
      unitPriceFen: gift ? 0 : Math.round(amountFen / qtyBase),
      amountFen,
      discountFen: gift ? 0 : Math.max(0, listAmount - amountFen),
      updatedAt,
      ...(gift ? { gift: true as const } : {})
    };
  });
}

interface BuildOrderArgs {
  orderId: string;
  deviceId: string;
  operator: string;
  createdAt: string;
  payMethod: PayMethod;
  sessionId: string;
  note?: string;
  lines: SaleLine[];
}

/** 由调用方已生成的 id/时间 + 明细组装订单（totalFen 按明细重算，id 不在内部生成） */
function buildOrder(args: BuildOrderArgs): SalesOrder {
  return {
    id: args.orderId,
    deviceId: args.deviceId,
    operator: args.operator,
    createdAt: args.createdAt,
    payMethod: args.payMethod,
    totalFen: args.lines.reduce((s, l) => s + l.amountFen, 0),
    sessionId: args.sessionId,
    note: args.note?.trim() || undefined,
    updatedAt: args.createdAt
  };
}

/** 保存一单：事务内写 order + lines；自动挂到本机 open 场次 */
export async function saveRecord(input: RecordInput): Promise<SalesOrder> {
  const session = input.sessionId
    ? await getSession(input.sessionId)
    : await ensureOpenSession(input.deviceId, input.operator);
  if (!session) throw new RecordError('SESSION_NOT_FOUND', SESSION_GONE_MSG);
  if (session.status !== 'open') {
    throw new RecordError('SESSION_CLOSED', '这一场已结账，用补记');
  }

  const orderId = uuid();
  const at = nowIso();
  const lines = buildLines(orderId, input.lines, at);
  const order = buildOrder({
    orderId,
    deviceId: input.deviceId,
    operator: input.operator,
    createdAt: at,
    payMethod: input.payMethod,
    sessionId: session.id,
    note: input.note,
    lines
  });

  await db.transaction('rw', db.orders, db.lines, async () => {
    await db.orders.put(order);
    await db.lines.bulkPut(lines);
  });
  await enqueueMany([
    { kind: 'order', recordId: order.id },
    ...lines.map((l) => ({ kind: 'line' as const, recordId: l.id }))
  ]);
  return order;
}

/** 编辑进行中的单（仅本场 open）。明细整组替换。 */
export async function updateRecord(id: string, input: RecordInput): Promise<SalesOrder> {
  const old = await db.orders.get(id);
  if (!old) throw new RecordError('SESSION_NOT_FOUND', '这单找不到了，刷新看看');
  const session = old.sessionId ? await db.sessions.get(old.sessionId) : undefined;
  if (!session || session.status !== 'open') {
    throw new RecordError('SESSION_CLOSED', '这一场已结账，用补记');
  }

  const oldLines = await db.lines.where('orderId').equals(id).toArray();
  const at = nowIso();
  const lines = buildLines(id, input.lines, at);
  const totalFen = lines.reduce((s, l) => s + l.amountFen, 0);
  const order: SalesOrder = {
    ...old,
    operator: input.operator || old.operator,
    payMethod: input.payMethod,
    totalFen,
    note: input.note?.trim() || undefined,
    updatedAt: at
  };

  await db.transaction('rw', db.orders, db.lines, async () => {
    await db.lines.where('orderId').equals(id).delete();
    await db.orders.put(order);
    await db.lines.bulkPut(lines);
  });
  await enqueueMany([
    { kind: 'order', recordId: id },
    ...oldLines.map((l) => ({ kind: 'line' as const, recordId: l.id, op: 'delete' as const })),
    ...lines.map((l) => ({ kind: 'line' as const, recordId: l.id }))
  ]);
  return order;
}

/** 删除进行中的单（仅本场 open）。已结账场次只能补记/作废。 */
export async function deleteRecord(id: string): Promise<void> {
  const order = await db.orders.get(id);
  if (!order) return;
  const session = order.sessionId ? await db.sessions.get(order.sessionId) : undefined;
  if (!session || session.status !== 'open') {
    throw new RecordError('SESSION_CLOSED', '这一场已结账，不能删除');
  }
  const lines = await db.lines.where('orderId').equals(id).toArray();
  await db.transaction('rw', db.orders, db.lines, async () => {
    await db.lines.where('orderId').equals(id).delete();
    await db.orders.delete(id);
  });
  await enqueueMany([
    { kind: 'order', recordId: id, op: 'delete' },
    ...lines.map((l) => ({ kind: 'line' as const, recordId: l.id, op: 'delete' as const }))
  ]);
}

/** 撤销补记：删除已结账场次里的补记单，补记计数 −1，重算快照 */
export async function undoPatchedRecord(id: string): Promise<void> {
  const order = await db.orders.get(id);
  if (!order?.sessionId) return;
  const session = await db.sessions.get(order.sessionId);
  if (!session || session.status !== 'closed') {
    await deleteRecord(id);
    return;
  }
  const lines = await db.lines.where('orderId').equals(id).toArray();
  const ledger = await loadLedger();
  const nextOrders = ledger.orders.filter((o) => o.id !== id);
  const nextLines = ledger.lines.filter((l) => l.orderId !== id);
  const summary = summarize(session.id, nextOrders, nextLines, ledger.batches);
  const nextSession: Session = {
    ...session,
    patchedCount: Math.max(0, session.patchedCount - 1),
    summary,
    updatedAt: nowIso()
  };
  await db.transaction('rw', db.sessions, db.orders, db.lines, async () => {
    await db.lines.where('orderId').equals(id).delete();
    await db.orders.delete(id);
    await db.sessions.put(nextSession);
  });
  await enqueueMany([
    { kind: 'order', recordId: id, op: 'delete' },
    ...lines.map((l) => ({ kind: 'line' as const, recordId: l.id, op: 'delete' as const })),
    { kind: 'session', recordId: session.id }
  ]);
}

/** 收摊结账：算快照 → 标记 closed；不删任何单 */
export async function closeSession(sessionId: string, operator: string): Promise<Session> {
  const session = await db.sessions.get(sessionId);
  if (!session) throw new RecordError('SESSION_NOT_FOUND', SESSION_GONE_MSG);
  if (session.status === 'closed') {
    throw new RecordError('ALREADY_CLOSED', '这一场已经结过账了');
  }

  const { orders, lines, batches } = await loadLedger();
  const summary = summarize(sessionId, orders, lines, batches);

  const next: Session = {
    ...session,
    status: 'closed',
    closedAt: nowIso(),
    closedBy: operator,
    summary,
    updatedAt: nowIso()
  };
  await db.sessions.put(next);
  await enqueue('session', sessionId);
  return next;
}

/** 撤销结账：仅下一场尚未开始时允许 */
export async function reopenSession(sessionId: string): Promise<Session> {
  const session = await db.sessions.get(sessionId);
  if (!session) throw new RecordError('SESSION_NOT_FOUND', SESSION_GONE_MSG);
  if (session.status !== 'closed') {
    throw new RecordError('NOT_CLOSED', '这一场还没结账');
  }
  const later = await db.sessions.where('startedAt').above(session.startedAt).count();
  if (later > 0) {
    throw new RecordError('NEXT_SESSION_STARTED', '下一场已经开始，不能撤销结账');
  }
  const next: Session = { ...session, status: 'open', updatedAt: nowIso() };
  delete next.closedAt;
  delete next.closedBy;
  delete next.summary;
  await db.sessions.put(next);
  await enqueue('session', sessionId);
  return next;
}

/** 补记到已结账场次：写单 + patchedCount +1 + 重算快照 */
export async function addPatchedRecord(input: RecordInput & { sessionId: string }): Promise<SalesOrder> {
  const session = await db.sessions.get(input.sessionId);
  if (!session) throw new RecordError('SESSION_NOT_FOUND', SESSION_GONE_MSG);
  if (session.status !== 'closed') {
    throw new RecordError('NOT_CLOSED', '这一场还在进行中，直接记一笔就行');
  }

  const orderId = uuid();
  const createdAt = nowIso();
  const lines = buildLines(orderId, input.lines, createdAt);
  const order = buildOrder({
    orderId,
    deviceId: input.deviceId,
    operator: input.operator,
    createdAt,
    payMethod: input.payMethod,
    sessionId: session.id,
    note: input.note,
    lines
  });

  const ledger = await loadLedger();
  const nextOrders = [...ledger.orders, order];
  const nextLines = [...ledger.lines, ...lines];
  const summary = summarize(session.id, nextOrders, nextLines, ledger.batches);
  const nextSession: Session = {
    ...session,
    patchedCount: session.patchedCount + 1,
    summary,
    updatedAt: createdAt
  };

  await db.transaction('rw', db.sessions, db.orders, db.lines, async () => {
    await db.orders.put(order);
    await db.lines.bulkPut(lines);
    await db.sessions.put(nextSession);
  });
  await enqueueMany([
    { kind: 'order', recordId: order.id },
    ...lines.map((l) => ({ kind: 'line' as const, recordId: l.id })),
    { kind: 'session', recordId: session.id }
  ]);
  return order;
}

/** 重算并写回某场次的快照（编辑/删除后调用） */
export async function refreshSessionSummary(sessionId: string): Promise<SessionSummary | undefined> {
  const session = await db.sessions.get(sessionId);
  if (!session) return undefined;
  const { orders, lines, batches } = await loadLedger();
  const summary = summarize(sessionId, orders, lines, batches);
  await db.sessions.put({ ...session, summary, updatedAt: nowIso() });
  await enqueue('session', sessionId);
  return summary;
}

/**
 * 作废 / 恢复订单后重算快照：只对已结账场次生效。
 * open 场次的报表本来就按 sessionReport 实时算，写快照只会给它凭空造一份 summary。
 */
async function refreshClosedSessionSummary(sessionId?: string): Promise<void> {
  if (!sessionId) return;
  const session = await db.sessions.get(sessionId);
  if (session?.status !== 'closed') return;
  await refreshSessionSummary(sessionId);
}

/* ------------------------------------------------------------------ 迁移 */

/**
 * 历史订单 → 场次。按本地自然日分组，相邻单间隔 > 4h 视作新的一场。
 * 幂等：完成后写 setting sessionsMigrated=1。
 */
export async function migrateSessions(): Promise<number> {
  const done = (await db.settings.get(SETTING_KEYS.sessionsMigrated))?.value;
  const pending = (await db.orders.toArray())
    .filter((o) => !o.sessionId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  if (pending.length === 0) {
    if (done !== SESSIONS_MIGRATED_VALUE) {
      await setSetting(SETTING_KEYS.sessionsMigrated, SESSIONS_MIGRATED_VALUE);
    }
    return 0;
  }

  const groups = groupOrdersBySession(pending);

  const { orders: allOrders, lines: allLines, batches } = await loadLedger();
  const sessionOfOrder = new Map<string, string>();
  const sessions: Session[] = [];

  for (const group of groups) {
    const first = group[0];
    const last = group[group.length - 1];
    const now = nowIso();
    const s: Session = {
      id: uuid(),
      deviceId: first.deviceId,
      startedAt: first.createdAt,
      closedAt: last.createdAt,
      status: 'closed',
      openedBy: first.operator,
      closedBy: first.operator,
      patchedCount: 0,
      updatedAt: now
    };
    for (const o of group) sessionOfOrder.set(o.id, s.id);
    sessions.push(s);
  }

  // 用迁移后的订单集合算快照
  const migratedOrders = allOrders.map((o) => {
    const sid = sessionOfOrder.get(o.id);
    return sid ? { ...o, sessionId: sid } : o;
  });
  // 例外：迁移在启动路径上，只重放一次 FIFO 供逐场复用；改用 summarize 会变成 N 次全量重放。
  const fifo = fifoAllocate(batches, migratedOrders, allLines);
  for (const s of sessions) s.summary = sessionReport(s.id, migratedOrders, allLines, fifo);

  await db.transaction('rw', db.sessions, db.orders, db.settings, async () => {
    await db.sessions.bulkPut(sessions);
    await db.orders.bulkPut(migratedOrders.filter((o) => sessionOfOrder.has(o.id)));
    await db.settings.put({ key: SETTING_KEYS.sessionsMigrated, value: SESSIONS_MIGRATED_VALUE });
  });

  await enqueueMany([
    ...sessions.map((s) => ({ kind: 'session' as const, recordId: s.id })),
    ...migratedOrders
      .filter((o) => sessionOfOrder.has(o.id))
      .map((o) => ({ kind: 'order' as const, recordId: o.id }))
  ]);
  return sessions.length;
}

export async function voidOrder(id: string): Promise<void> {
  const o = await db.orders.get(id);
  if (!o) return;
  await db.orders.put({ ...o, voided: true, updatedAt: nowIso() });
  await enqueue('order', id);
  await refreshClosedSessionSummary(o.sessionId);
}

export async function restoreOrder(id: string): Promise<void> {
  const o = await db.orders.get(id);
  if (!o) return;
  const next = { ...o, updatedAt: nowIso() };
  delete next.voided;
  await db.orders.put(next);
  await enqueue('order', id);
  await refreshClosedSessionSummary(o.sessionId);
}

/* ------------------------------------------------------------------ 调整 */

export async function createAdjustment(
  input: { productId: string; qtyBase: number; type: AdjustType; reason?: string },
  deviceId: string
): Promise<Adjustment> {
  const createdAt = nowIso();
  const a: Adjustment = {
    id: uuid(),
    productId: input.productId,
    qtyBase: Math.round(input.qtyBase),
    type: input.type,
    reason: input.reason?.trim() || undefined,
    createdAt,
    deviceId,
    updatedAt: createdAt
  };
  await db.adjustments.put(a);
  await enqueue('adjustment', a.id);
  return a;
}

/* ------------------------------------------------------------------ 统计辅助 */

export async function loadAll(): Promise<AppData> {
  const [products, batches, orders, lines, adjustments, sessions, settings] = await Promise.all([
    db.products.toArray(),
    db.batches.toArray(),
    db.orders.toArray(),
    db.lines.toArray(),
    db.adjustments.toArray(),
    db.sessions.toArray(),
    db.settings.toArray()
  ]);
  return { products, batches, orders, lines, adjustments, sessions, settings };
}

export async function clearAllData(): Promise<void> {
  // 冲突留痕随本次「清空」一起删，避免清完还显示历史冲突数
  await db.transaction(
    'rw',
    [db.products, db.batches, db.orders, db.lines, db.adjustments, db.sessions, db.conflicts],
    async () => {
      await Promise.all([
        db.products.clear(),
        db.batches.clear(),
        db.orders.clear(),
        db.lines.clear(),
        db.adjustments.clear(),
        db.sessions.clear(),
        db.conflicts.clear()
      ]);
    }
  );
  // 这两次 setSetting 会登记发件箱，因此 outbox 必须最后清
  await setSetting(SETTING_KEYS.seeded, '');
  await setSetting(SETTING_KEYS.sessionsMigrated, '');
  await db.outbox.clear();
}

export type { Setting };
