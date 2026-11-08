import Dexie, { type Table } from 'dexie';
import type {
  Adjustment,
  Batch,
  Product,
  SaleLine,
  SalesOrder,
  Session,
  Setting
} from './types';

export interface OutboxRow {
  /** `${kind}:${recordId}` */
  id: string;
  kind: 'product' | 'batch' | 'order' | 'line' | 'adjustment' | 'session' | 'setting';
  recordId: string;
  op: 'upsert' | 'delete';
  queuedAt: number;
}

export class AppDB extends Dexie {
  products!: Table<Product, string>;
  batches!: Table<Batch, string>;
  orders!: Table<SalesOrder, string>;
  lines!: Table<SaleLine, string>;
  adjustments!: Table<Adjustment, string>;
  sessions!: Table<Session, string>;
  settings!: Table<Setting, string>;
  outbox!: Table<OutboxRow, string>;

  constructor() {
    super('yanhuo-erp');
    this.version(1).stores({
      products: 'id, category, name, archived, sortOrder',
      batches: 'id, productId, receivedAt, expiryDate',
      orders: 'id, createdAt, deviceId, payMethod, voided',
      lines: 'id, orderId, productId',
      adjustments: 'id, productId, createdAt',
      settings: 'key'
    });
    this.version(2).stores({
      outbox: 'id, queuedAt'
    });
    // v3：事后记账模型。sessions 只加表；orders 加 sessionId 索引（不重建记录）。
    this.version(3).stores({
      sessions: 'id, status, startedAt, closedAt, deviceId',
      orders: 'id, createdAt, deviceId, payMethod, voided, sessionId'
    });
  }
}

export const db = new AppDB();