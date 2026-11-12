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
  /**
   * 自增主键。
   * 注意：去重口径是 `(kind, recordId)`（v5 起加了复合索引），不是名字里的 `id`；
   * 同一单再次冲突时复用这一行的主键原地更新，不再新增（见 H2.2）。
   */
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
export const SCHEMA_VERSION = 5;

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
    this.version(4).stores({
      conflicts: '++id, at, kind, recordId'
    });
    /**
     * v5（H2.2）：冲突表按 `(kind, recordId)` 去重。
     * 主键仍是自增 id（不改主键就不会丢老数据），只加复合索引；
     * 写入侧用 `where('[kind+recordId]')` 找到已有行原地更新。
     *
     * 迁移：老版本是「每轮冲突 bulkAdd 一行」，同一单可能已经堆了多行。
     * 这里折叠加同一条记录只留 `at` 最新的一行 —— 旧数据处理掉重复、不丢内容，
     * 升级后设置页的「待核对 N 条」不会再带着历史噪音。
     */
    this.version(SCHEMA_VERSION)
      .stores({ conflicts: '++id, at, kind, recordId, [kind+recordId]' })
      .upgrade(async (tx) => {
        const table = tx.table('conflicts');
        const rows = (await table.toArray()) as {
          id?: number;
          at?: string;
          kind?: string;
          recordId?: string;
        }[];
        // `at` 是 ISO 字符串，字典序即时间序
        const keep = new Map<string, { id?: number; at?: string }>();
        for (const row of rows) {
          if (typeof row.id !== 'number' || !row.kind || !row.recordId) continue;
          const key = `${row.kind}:${row.recordId}`;
          const prev = keep.get(key);
          if (!prev) {
            keep.set(key, row);
            continue;
          }
          if ((row.at ?? '') > (prev.at ?? '')) {
            await table.delete(prev.id as number);
            keep.set(key, row);
          } else {
            await table.delete(row.id);
          }
        }
      });
  }
}

export const db = new AppDB();