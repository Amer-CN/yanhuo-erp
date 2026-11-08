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

/** 同步冲突留痕：同一记录两端都改过、又无法按业务时间判定时，保留双方快照 */
export interface SyncConflictRow {
  id?: number;
  at: string;
  kind: string;
  recordId: string;
  /** 本地记录 JSON（本地保留，不被覆盖） */
  local: string;
  /** 远端记录 JSON */
  remote: string;
}

/** 主库 schema 版本：唯一来源。升版本前先看 backup.snapshotBeforeOpen 的迁移快照 */
export const SCHEMA_VERSION = 4;

export class AppDB extends Dexie {
  products!: Table<Product, string>;
  batches!: Table<Batch, string>;
  orders!: Table<SalesOrder, string>;
  lines!: Table<SaleLine, string>;
  adjustments!: Table<Adjustment, string>;
  sessions!: Table<Session, string>;
  settings!: Table<Setting, string>;
  outbox!: Table<OutboxRow, string>;
  conflicts!: Table<SyncConflictRow, number>;

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
    // v4：同步冲突留痕（不改任何业务表，只加 conflicts）
    this.version(SCHEMA_VERSION).stores({
      conflicts: '++id, at, kind, recordId'
    });
  }
}

export const db = new AppDB();