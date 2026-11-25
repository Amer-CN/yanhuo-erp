export interface SyncControlRow {
  key: 'state';
  generation: number;
  /** 仅在维护/恢复/清空/重连确认造成数据换代时递增；普通 pause 不变。 */
  dataGeneration: number;
  paused: boolean;
  reason: string | null;
  maintenance: boolean;
  fence: number;
  ownerId: string | null;
  expiresAt: number;
}

/** 只传递能力凭证；expiresAt 每次校验从 IDB 读取，不能缓存。 */
export interface SyncLease {
  readonly generation: number;
  readonly ownerId: string;
  readonly fence: number;
  readonly maintenance: boolean;
  readonly signal: AbortSignal;
}

export type SyncCallback<T> = (lease: SyncLease) => T | Promise<T>;
export type SyncControlErrorCode =
  'SYNC_PAUSED' | 'SYNC_BUSY' | 'SYNC_LEASE_LOST' | 'SYNC_MAINTENANCE' | 'SYNC_GENERATION_MISMATCH';

export interface SyncConfig {
  url: string;
  anonKey: string;
  ledgerKey: string;
}
