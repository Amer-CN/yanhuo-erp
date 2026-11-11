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
import { activeOrderIds, batchOrderKey, fifoAllocate, sessionReport } from './calc';
import { groupOrdersBySession, pickOpenSession } from './sessionLogic';
import { localDate, nowIso, uuid } from './util';
import { enqueueInTx, syncWanted, type OutboxItem } from './outbox';
import type { Table } from 'dexie';

/* ------------------------------------------------- 写入 + 入队同事务（M-1） */

/**
 * 业务写入与发件箱入队放进**同一个 Dexie 事务**（Dexie 支持跨表同事务）。
 *
 * 为什么必须这样：原先的写法是「事务落账 → 事务结束 → 再 `enqueue`」，两段各自独立。
 * 入队那一步若抛错（配额、库版本变更、标签页被系统回收），记录已入库却**永远不会被推送**；
 * 同时异常冒到 UI 会提示「保存失败」→ 摊主重录 → 同一单重复记账。仓里没有补扫机制，
 * 这类记录只能人工发现。合并成一个事务后，入队失败会连业务写入一起回滚，语义变成「要么都成，要么都没发生」。
 *
 * 两个约定：
 * - `db.outbox` 必须显式纳入事务表清单（缺了 Dexie 会抛 `TransactionScopeError`）；
 * - `syncWanted()` 放在**提交之后**：事件回调会立刻发起同步，事务未提交时去读会读到旧状态。
 *
 * @param tables 本次业务写入涉及的表（不含 outbox，由本函数补上）
 * @param write 业务写入（必须在同一事务内完成，不要在这里面再开事务）
 * @param items 需要登记到发件箱的记录
 */
export async function writeWithOutbox(
  tables: Table[],
  write: () => Promise<void>,
  items: OutboxItem[]
): Promise<void> {
  await db.transaction('rw', [...tables, db.outbox], async () => {
    await write();
    await enqueueInTx(items);
  });
  syncWanted();
}

/* ------------------------------------------------------------------ 设置 */

export async function getSetting(key: string): Promise<string | undefined> {
  return (await db.settings.get(key))?.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await writeWithOutbox(
    [db.settings],
    async () => {
      await db.settings.put({ key, value });
    },
    [{ kind: 'setting', recordId: key }]
  );
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
 *
 * 额外做一步 `operatorA → operatorSelf` 迁移（M-2）：一台手机 = 一个人，老版本只设了
 * operatorA/B。若 operatorSelf 为空而 operatorA 有值，就把它当作本机编号。
 * **只读老键、不回写**（历史单仍按 operatorA 的字符串显示）；本机专属键由入队处过滤，
 * 所以这一步不会产生发件箱行。
 */
export async function ensureBootstrapSettings(defaults: Record<string, string>): Promise<void> {
  const keys = Object.keys(defaults);
  const rows = await db.settings.toArray();
  const present = new Map(rows.map((r) => [r.key, r.value]));
  // 只看 key 是否存在：clearAllData 会把值置空，空串仍是「已初始化」
  const toWrite: Record<string, string> = {};
  for (const k of keys) {
    if (!present.has(k)) toWrite[k] = defaults[k];
  }
  if (!present.has(SETTING_KEYS.operatorSelf)) {
    const legacy = (present.get(SETTING_KEYS.operatorA) ?? '').trim();
    if (legacy) toWrite[SETTING_KEYS.operatorSelf] = legacy;
  }
  const writeKeys = Object.keys(toWrite);
  if (writeKeys.length === 0) return;
  await writeWithOutbox(
    [db.settings],
    async () => {
      await db.settings.bulkPut(writeKeys.map((k) => ({ key: k, value: toWrite[k] })));
    },
    writeKeys.map((k) => ({ kind: 'setting' as const, recordId: k }))
  );
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
  await writeWithOutbox(
    [db.products],
    async () => {
      await db.products.put(p);
    },
    [{ kind: 'product', recordId: p.id }]
  );
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
  await writeWithOutbox(
    [db.products],
    async () => {
      await db.products.put(next);
    },
    [{ kind: 'product', recordId: id }]
  );
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
  await writeWithOutbox(
    [db.products],
    async () => {
      await db.products.delete(id);
    },
    [{ kind: 'product', recordId: id, op: 'delete' }]
  );
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

/**
 * 该批次是否排在商品 FIFO 队列的末尾（队尾批次不会被历史明细扣到，不会改写历史成本）。
 * 排序键直接用 `calc.batchOrderKey`：与 `fifoAllocate` 的批次排队是同一条口径，
 * 不再在本地复刻拼接串（两边漂移会导致该重算的快照被静默跳过）。
 */
function isFifoLast(siblings: Batch[], batch: Batch): boolean {
  const key = batchOrderKey(batch);
  return siblings.every((b) => b.id === batch.id || batchOrderKey(b) < key);
}

export async function createBatch(input: BatchInput, deviceId: string): Promise<Batch> {
  // 与明细侧 buildLines 的 INVALID_QTY 对称的兜底校验。
  // 进货页本身已有 qtyBase <= 0 的前置校验，这里防的是「同步 / 合并 / 脚本」这条旁路：
  // NaN 或负数批次会污染 inventoryMap 的库存累加、fifoAllocate 的兜底均价与已结账快照成本。
  const qty = Math.floor(input.qtyBase);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new RecordError('INVALID_QTY', '数量要大于 0');
  }
  // 进价不合法（NaN / 无穷 / 负数）同样会污染成本；RecordErrorCode 是既有白名单枚举，
  // 不新增错误码，复用语义最接近的 INVALID_AMOUNT（金额非法），文案按进价表述。
  if (!Number.isFinite(input.unitCostFen) || input.unitCostFen < 0) {
    throw new RecordError('INVALID_AMOUNT', '进价要填个数字，且不能是负数');
  }
  // 合法值才取整（保留原来 Math.max(0, …) 的取值口径）
  const unitCostFen = Math.max(0, Math.round(input.unitCostFen));
  const createdAt = nowIso();
  const b: Batch = {
    id: uuid(),
    productId: input.productId,
    batchNo: input.batchNo?.trim() || undefined,
    produceDate: input.produceDate || undefined,
    expiryDate: input.expiryDate || undefined,
    qtyBase: qty,
    unitCostFen,
    supplier: input.supplier?.trim() || undefined,
    receivedAt: input.receivedAt || localDate(),
    deviceId,
    createdAt,
    updatedAt: createdAt
  };
  await writeWithOutbox(
    [db.batches],
    async () => {
      await db.batches.put(b);
    },
    [{ kind: 'batch', recordId: b.id }]
  );
  // 新批次可能改写历史成本：① 插进 FIFO 队列中间（补录一张旧送货单）会顶替后面明细的成本；
  // ② 该商品本来就超卖时，兜底均价被重新加权。判断 + 重算都放在 best-effort 里：
  // 进货已经落库入队，不能因为补偿重算失败把「已进货」报成失败（用户会重录一条）。
  await bestEffortSnapshot(`补录进货后重算场次快照（商品 ${b.productId}）`, async () => {
    const siblings = await db.batches.where('productId').equals(b.productId).toArray();
    await refreshClosedSummariesAfterBatchChange(b.productId, !isFifoLast(siblings, b), b.qtyBase);
  });
  return b;
}

/**
 * 批次已卖出时的提示：必须给出用户当下真能执行的动作。
 * 仓库里目前没有「修改批次」能力（没有 updateBatch，进货页也没有编辑入口），
 * 所以不能承诺「改数量」，只能引导到库存页的「修正库存」记一笔调整。
 */
const BATCH_IN_USE_MSG =
  '这批货已经卖出去了，不能删（删了历史成本会变）；数量对不上请到「库存」里记一笔修正库存';

/** 删除进货批次；已经被 FIFO 扣过的批次不允许删（会不可逆改写历史成本） */
export async function deleteBatch(id: string): Promise<void> {
  const batch = await db.batches.get(id);
  // 批次不存在时保持原行为（直接删 + 入队 delete），不新增错误分支
  if (batch) {
    // 判定「这批货是否被扣过」只重放该商品的批次与明细：
    // fifoAllocate 内部按 productId 独立排队（byProduct / queueIdx / 兜底均价都按商品分组），
    // 所以单商品口径的 batchRemaining 与三张全表重放等价，代价从 O(全库明细) 降到 O(该商品明细)。
    const local = await loadProductLedger(batch.productId);
    const { batchRemaining } = fifoAllocate(local.batches, local.orders, local.lines);
    if ((batchRemaining.get(id) ?? 0) < batch.qtyBase) {
      throw new RecordError('BATCH_IN_USE', BATCH_IN_USE_MSG);
    }
  }
  await writeWithOutbox(
    [db.batches],
    async () => {
      await db.batches.delete(id);
    },
    [{ kind: 'batch', recordId: id, op: 'delete' }]
  );
  // 兜底均价按该商品全部批次加权，删批次理论上会改变超卖明细成本；
  // 正常情形（remaining === qtyBase）下该商品不可能有超卖明细，这里只是低成本兜底校验。
  if (batch) {
    await bestEffortSnapshot(`删除进货后重算场次快照（商品 ${batch.productId}）`, () =>
      refreshClosedSummariesAfterBatchChange(batch.productId, false, -batch.qtyBase)
    );
  }
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
  | 'NEXT_SESSION_STARTED'
  | 'BATCH_IN_USE';

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

/**
 * 本机正在进行中的场次（异常情况下有多条时取最晚开始的一场）
 * 判定规则统一走 `sessionLogic.pickOpenSession`，与首页/报表页同一口径；
 * 这里只是把「只查 open」的索引查询结果喂给它（结果集等价，省掉全表扫描）。
 */
export async function getOpenSession(deviceId: string): Promise<Session | undefined> {
  const rows = await db.sessions.where('status').equals('open').toArray();
  return pickOpenSession(rows, deviceId);
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
  await writeWithOutbox(
    [db.sessions],
    async () => {
      await db.sessions.put(session);
    },
    [{ kind: 'session', recordId: session.id }]
  );
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

/** 单商品口径的账本切片：批次增删的判定与快照重算只需要这一个商品的数据 */
interface ProductLedger {
  batches: Batch[];
  lines: SaleLine[];
  /** 这些明细所属的订单（已过滤找不到的脏引用） */
  orders: SalesOrder[];
}

/**
 * 按 productId 取批次 + 明细 + 明细所属订单。
 * `fifoAllocate` 内部按商品独立排队（byProduct / queueIdx / 兜底均价都按商品分组），
 * 所以单商品口径算出的 batchRemaining 与三张全表重放等价，代价是 O(该商品明细)。
 */
async function loadProductLedger(productId: string): Promise<ProductLedger> {
  const [batches, lines] = await Promise.all([
    db.batches.where('productId').equals(productId).toArray(),
    db.lines.where('productId').equals(productId).toArray()
  ]);
  const orderIds = [...new Set(lines.map((l) => l.orderId))];
  const orders = (await db.orders.bulkGet(orderIds)).filter((o): o is SalesOrder =>
    Boolean(o)
  );
  return { batches, lines, orders };
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

  await writeWithOutbox(
    [db.orders, db.lines],
    async () => {
      await db.orders.put(order);
      await db.lines.bulkPut(lines);
    },
    [
      { kind: 'order', recordId: order.id },
      ...lines.map((l) => ({ kind: 'line' as const, recordId: l.id }))
    ]
  );
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

  await writeWithOutbox(
    [db.orders, db.lines],
    async () => {
      await db.lines.where('orderId').equals(id).delete();
      await db.orders.put(order);
      await db.lines.bulkPut(lines);
    },
    [
      { kind: 'order', recordId: id },
      ...oldLines.map((l) => ({ kind: 'line' as const, recordId: l.id, op: 'delete' as const })),
      ...lines.map((l) => ({ kind: 'line' as const, recordId: l.id }))
    ]
  );
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
  await writeWithOutbox(
    [db.orders, db.lines],
    async () => {
      await db.lines.where('orderId').equals(id).delete();
      await db.orders.delete(id);
    },
    [
      { kind: 'order', recordId: id, op: 'delete' },
      ...lines.map((l) => ({ kind: 'line' as const, recordId: l.id, op: 'delete' as const }))
    ]
  );
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
  await writeWithOutbox(
    [db.sessions, db.orders, db.lines],
    async () => {
      await db.lines.where('orderId').equals(id).delete();
      await db.orders.delete(id);
      await db.sessions.put(nextSession);
    },
    [
      { kind: 'order', recordId: id, op: 'delete' },
      ...lines.map((l) => ({ kind: 'line' as const, recordId: l.id, op: 'delete' as const })),
      { kind: 'session', recordId: session.id }
    ]
  );
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
  await writeWithOutbox(
    [db.sessions],
    async () => {
      await db.sessions.put(next);
    },
    [{ kind: 'session', recordId: sessionId }]
  );
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
  await writeWithOutbox(
    [db.sessions],
    async () => {
      await db.sessions.put(next);
    },
    [{ kind: 'session', recordId: sessionId }]
  );
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

  await writeWithOutbox(
    [db.sessions, db.orders, db.lines],
    async () => {
      await db.orders.put(order);
      await db.lines.bulkPut(lines);
      await db.sessions.put(nextSession);
    },
    [
      { kind: 'order', recordId: order.id },
      ...lines.map((l) => ({ kind: 'line' as const, recordId: l.id })),
      { kind: 'session', recordId: session.id }
    ]
  );
  return order;
}

/**
 * 重算并写回某场次的快照（编辑/删除后调用）。
 * 复杂度：读三张全表 + 一次全量 FIFO 重放，O(全库明细)；单场次场景下暂时接受，
 * 统一收敛留给性能批次（M-001 / M-006 / M-008），不要在这里再加一遍全量重放。
 */
export async function refreshSessionSummary(sessionId: string): Promise<SessionSummary | undefined> {
  const session = await db.sessions.get(sessionId);
  if (!session) return undefined;
  const { orders, lines, batches } = await loadLedger();
  const summary = summarize(sessionId, orders, lines, batches);
  await writeWithOutbox(
    [db.sessions],
    async () => {
      await db.sessions.put({ ...session, summary, updatedAt: nowIso() });
    },
    [{ kind: 'session', recordId: sessionId }]
  );
  return summary;
}

/**
 * 批量写回多个已结账场次的快照：一次读全表 + 一次 FIFO 重放供所有场次复用。
 * 口径与 migrateSessions 一致，避免 N 个场次触发 N 次全量重放。
 * 只处理 status === 'closed' 的场次：open 场次的报表由 sessionReport 实时算。
 */
async function writeClosedSummaries(sessionIds: string[]): Promise<number> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return 0;
  const rows = await db.sessions.bulkGet(ids);
  const targets = rows.filter((s): s is Session => s?.status === 'closed');
  if (targets.length === 0) return 0;

  const { orders, lines, batches } = await loadLedger();
  const fifo = fifoAllocate(batches, orders, lines);
  const at = nowIso();
  const next: Session[] = targets.map((s) => ({
    ...s,
    summary: sessionReport(s.id, orders, lines, fifo),
    updatedAt: at
  }));
  await writeWithOutbox(
    [db.sessions],
    async () => {
      await db.sessions.bulkPut(next);
    },
    next.map((s) => ({ kind: 'session' as const, recordId: s.id }))
  );
  return next.length;
}

/**
 * 作废 / 恢复订单后重算快照：只对已结账场次生效。
 * open 场次的报表本来就按 sessionReport 实时算，写快照只会给它凭空造一份 summary。
 */
async function refreshClosedSessionSummary(sessionId?: string): Promise<void> {
  if (!sessionId) return;
  await writeClosedSummaries([sessionId]);
}

/**
 * 批次增删后重算受影响的已结账场次快照。
 *
 * 为什么需要：兜底均价 `productAvgCostFen` 把该商品「全部批次」纳入加权，而 summary 是落库快照。
 * 历史成本会变的三种情形（任一成立才重算）：
 *  ① fifoReordered：新批次插进队列中间（补录旧送货单），顶替了后面明细的成本；
 *  ② 变动前超卖：原先靠兜底均价估的明细，现在被新批次覆盖；
 *  ③ 变动后超卖：进货量不够卖了，明细开始用兜底均价。
 * 反过来说，队尾追加且变动前后都不超卖时，扣批序列与兜底均价都不参与成本，历史金额一个字不变，
 * 直接跳过可以让进货/删货不必每次重写快照（也避免 updatedAt 与发件箱抖动）。
 *
 * 删批次时 fifoReordered 恒为 false：能删的批次一定没被扣过（remaining === qtyBase），
 * 正常数据下 ②③ 也不成立，所以这里几乎总是短路；保留校验是为了兜住脏数据
 * （例如 qtyBase ≤ 0 的批次会参与兜底均价加权）。
 *
 * 代价：命中时 O(全库明细) 一次（与 migrateSessions 同口径，一次供所有受影响场次复用），属低频操作。
 */
async function refreshClosedSummariesAfterBatchChange(
  productId: string,
  fifoReordered: boolean,
  stockedDeltaQty: number
): Promise<number> {
  const { batches, lines, orders } = await loadProductLedger(productId);
  const active = activeOrderIds(orders);
  if (!fifoReordered) {
    const soldQty = lines
      .filter((l) => active.has(l.orderId))
      .reduce((s, l) => s + l.qtyBase, 0);
    const stockedAfter = batches.reduce((s, b) => s + b.qtyBase, 0);
    const stockedBefore = stockedAfter - stockedDeltaQty;
    // 变动前后进货量都够卖：没有任何明细靠兜底均价，成本不受影响
    if (soldQty <= stockedAfter && soldQty <= stockedBefore) return 0;
  }
  const sessionIds = new Set<string>();
  for (const o of orders) {
    if (o.sessionId && active.has(o.id)) sessionIds.add(o.sessionId);
  }
  return writeClosedSummaries([...sessionIds]);
}

/**
 * 快照重算的 best-effort 包装：此时主记录已经落库并入队，重算失败只影响报表数字的即时性，
 * 绝不能把「已经生效的写入」报成失败（页面会以为没生效而反复点击、重录）。
 * 失败留一条本机诊断，等下次结账 / 重算时自然对齐。
 */
async function bestEffortSnapshot(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (e) {
    console.warn(`[repo] ${label}失败，报表数字稍后需重算对齐`, e);
  }
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

  await writeWithOutbox(
    [db.sessions, db.orders, db.settings],
    async () => {
      await db.sessions.bulkPut(sessions);
      await db.orders.bulkPut(migratedOrders.filter((o) => sessionOfOrder.has(o.id)));
      await db.settings.put({
        key: SETTING_KEYS.sessionsMigrated,
        value: SESSIONS_MIGRATED_VALUE
      });
    },
    [
      ...sessions.map((s) => ({ kind: 'session' as const, recordId: s.id })),
      ...migratedOrders
        .filter((o) => sessionOfOrder.has(o.id))
        .map((o) => ({ kind: 'order' as const, recordId: o.id }))
    ]
  );
  return sessions.length;
}

/**
 * 整单作废。订单落库 + 入队之后才重算快照，且重算走 best-effort：
 * 作废本身已经生效，快照重算失败不能把结果报成失败。
 * 重算口径是 O(全库明细)（见 refreshSessionSummary 注释），留给性能批次统一处理。
 */
export async function voidOrder(id: string): Promise<void> {
  const o = await db.orders.get(id);
  if (!o) return;
  await writeWithOutbox(
    [db.orders],
    async () => {
      await db.orders.put({ ...o, voided: true, updatedAt: nowIso() });
    },
    [{ kind: 'order', recordId: id }]
  );
  await bestEffortSnapshot('作废订单后重算场次快照', () => refreshClosedSessionSummary(o.sessionId));
}

/** 撤销作废：与 voidOrder 同口径（先落库入队，快照重算 best-effort） */
export async function restoreOrder(id: string): Promise<void> {
  const o = await db.orders.get(id);
  if (!o) return;
  const next = { ...o, updatedAt: nowIso() };
  delete next.voided;
  await writeWithOutbox(
    [db.orders],
    async () => {
      await db.orders.put(next);
    },
    [{ kind: 'order', recordId: id }]
  );
  await bestEffortSnapshot('恢复订单后重算场次快照', () => refreshClosedSessionSummary(o.sessionId));
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
  await writeWithOutbox(
    [db.adjustments],
    async () => {
      await db.adjustments.put(a);
    },
    [{ kind: 'adjustment', recordId: a.id }]
  );
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
