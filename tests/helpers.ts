// 数据层单测共用夹具：真实 fake-indexeddb + 固定时间（不依赖真实时钟）。
import { db } from '../src/db/db';
import type { Adjustment, Batch, Product, SaleLine, SalesOrder, Session } from '../src/db/types';

export const DEVICE = 'dev-test';
export const T0 = '2026-11-01T10:00:00.000Z';

export async function resetDb(): Promise<void> {
  await Promise.all([
    db.products.clear(),
    db.batches.clear(),
    db.orders.clear(),
    db.lines.clear(),
    db.adjustments.clear(),
    db.sessions.clear(),
    db.settings.clear()
  ]);
  await db.outbox.clear();
}

export function makeProduct(id = 'p1', overrides: Partial<Product> = {}): Product {
  return {
    id,
    name: `商品${id}`,
    category: '炮',
    unitBase: '个',
    boxQty: 10,
    priceList: 1000,
    negotiable: true,
    archived: false,
    sortOrder: 0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides
  };
}

export function makeBatch(
  id: string,
  productId: string,
  qtyBase: number,
  unitCostFen: number,
  receivedAt = '2026-11-01'
): Batch {
  return {
    id,
    productId,
    qtyBase,
    unitCostFen,
    receivedAt,
    deviceId: DEVICE,
    createdAt: T0
  };
}

export function makeAdjustment(
  id: string,
  productId: string,
  qtyBase: number,
  overrides: Partial<Adjustment> = {}
): Adjustment {
  return {
    id,
    productId,
    qtyBase,
    type: qtyBase >= 0 ? 'correction' : 'loss',
    createdAt: T0,
    deviceId: DEVICE,
    ...overrides
  };
}

export function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    deviceId: DEVICE,
    startedAt: T0,
    status: 'open',
    openedBy: '我',
    patchedCount: 0,
    updatedAt: T0,
    ...overrides
  };
}

export function makeOrder(
  id: string,
  totalFen: number,
  sessionId = 's1',
  overrides: Partial<SalesOrder> = {}
): SalesOrder {
  return {
    id,
    deviceId: DEVICE,
    operator: '我',
    createdAt: T0,
    payMethod: 'cash',
    totalFen,
    sessionId,
    ...overrides
  };
}

export function makeLine(
  id: string,
  orderId: string,
  productId: string,
  qtyBase: number,
  amountFen: number,
  overrides: Partial<SaleLine> = {}
): SaleLine {
  return {
    id,
    orderId,
    productId,
    qtyBase,
    unit: 'base',
    qty: qtyBase,
    listUnitPriceFen: qtyBase > 0 ? Math.round(amountFen / qtyBase) : 0,
    unitPriceFen: qtyBase > 0 ? Math.round(amountFen / qtyBase) : 0,
    amountFen,
    discountFen: 0,
    ...overrides
  };
}