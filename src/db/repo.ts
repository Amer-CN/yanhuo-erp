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
  Setting
} from './types';
import { SETTING_KEYS } from './types';
import { localDate, nowIso, uuid } from './util';

/* ------------------------------------------------------------------ 设置 */

export async function getSetting(key: string): Promise<string | undefined> {
  return (await db.settings.get(key))?.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db.settings.put({ key, value });
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
  return p;
}

export async function updateProduct(id: string, patch: Partial<ProductInput> & { archived?: boolean }): Promise<void> {
  const old = await db.products.get(id);
  if (!old) return;
  const next: Product = { ...old, ...patch, updatedAt: nowIso() } as Product;
  if (patch.name !== undefined) next.name = patch.name.trim();
  if (patch.unitBase !== undefined) next.unitBase = patch.unitBase.trim() || '个';
  if (patch.boxQty !== undefined) next.boxQty = Math.max(0, Math.floor(patch.boxQty));
  if (patch.priceList !== undefined) next.priceList = Math.max(0, Math.round(patch.priceList));
  await db.products.put(next);
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
    createdAt: nowIso()
  };
  await db.batches.put(b);
  return b;
}

export async function deleteBatch(id: string): Promise<void> {
  await db.batches.delete(id);
}

/* ------------------------------------------------------------------ 开单 */

export interface CartLineInput {
  productId: string;
  qtyBase: number;
  unit: 'box' | 'base';
  qty: number;
  listUnitPriceFen: number;
  unitPriceFen: number;
}

export interface CheckoutInput {
  deviceId: string;
  operator: string;
  payMethod: PayMethod;
  lines: CartLineInput[];
  note?: string;
}

export async function checkout(input: CheckoutInput): Promise<SalesOrder> {
  const orderId = uuid();
  const createdAt = nowIso();
  const lines: SaleLine[] = input.lines.map((l) => {
    const amountFen = l.qtyBase * l.unitPriceFen;
    return {
      id: uuid(),
      orderId,
      productId: l.productId,
      qtyBase: l.qtyBase,
      unit: l.unit,
      qty: l.qty,
      listUnitPriceFen: l.listUnitPriceFen,
      unitPriceFen: l.unitPriceFen,
      amountFen,
      discountFen: Math.max(0, (l.listUnitPriceFen - l.unitPriceFen) * l.qtyBase)
    };
  });
  const totalFen = lines.reduce((s, l) => s + l.amountFen, 0);
  const order: SalesOrder = {
    id: orderId,
    deviceId: input.deviceId,
    operator: input.operator,
    createdAt,
    payMethod: input.payMethod,
    totalFen,
    note: input.note?.trim() || undefined
  };
  await db.transaction('rw', db.orders, db.lines, async () => {
    await db.orders.put(order);
    await db.lines.bulkPut(lines);
  });
  return order;
}

export async function voidOrder(id: string): Promise<void> {
  const o = await db.orders.get(id);
  if (!o) return;
  await db.orders.put({ ...o, voided: true });
}

export async function restoreOrder(id: string): Promise<void> {
  const o = await db.orders.get(id);
  if (!o) return;
  const next = { ...o };
  delete next.voided;
  await db.orders.put(next);
}

/* ------------------------------------------------------------------ 调整 */

export async function createAdjustment(
  input: { productId: string; qtyBase: number; type: AdjustType; reason?: string },
  deviceId: string
): Promise<Adjustment> {
  const a: Adjustment = {
    id: uuid(),
    productId: input.productId,
    qtyBase: Math.round(input.qtyBase),
    type: input.type,
    reason: input.reason?.trim() || undefined,
    createdAt: nowIso(),
    deviceId
  };
  await db.adjustments.put(a);
  return a;
}

/* ------------------------------------------------------------------ 统计辅助 */

export async function loadAll(): Promise<AppData> {
  const [products, batches, orders, lines, adjustments, settings] = await Promise.all([
    db.products.toArray(),
    db.batches.toArray(),
    db.orders.toArray(),
    db.lines.toArray(),
    db.adjustments.toArray(),
    db.settings.toArray()
  ]);
  return { products, batches, orders, lines, adjustments, settings };
}

export async function clearAllData(): Promise<void> {
  await db.transaction(
    'rw',
    [db.products, db.batches, db.orders, db.lines, db.adjustments],
    async () => {
      await Promise.all([
        db.products.clear(),
        db.batches.clear(),
        db.orders.clear(),
        db.lines.clear(),
        db.adjustments.clear()
      ]);
    }
  );
  await setSetting(SETTING_KEYS.seeded, '');
}

export type { Setting };