// 同步冲突决策（纯函数，便于表驱动单测）：
// 业务时间新者胜；时间相同/缺失时按记录类型兜底；无法判定时留冲突、本地不覆盖。

import { mergeSessionPair } from './sessionLogic';
import type { Product, SalesOrder, Session } from './types';

export type SyncKind =
  | 'product'
  | 'batch'
  | 'order'
  | 'line'
  | 'adjustment'
  | 'session'
  | 'setting';

export type ResolveDecision = 'take-remote' | 'keep-local' | 'conflict';

/** 记录的业务修改时间（毫秒）；旧数据缺 updatedAt 时用 createdAt/startedAt 兜底 */
export function businessTime(record: unknown): number {
  const r = record as
    | { updatedAt?: string; createdAt?: string; startedAt?: string }
    | null
    | undefined;
  if (!r) return 0;
  const iso = r.updatedAt ?? r.createdAt ?? r.startedAt ?? '';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function normalize(record: unknown, id: string): unknown {
  if (record && typeof record === 'object') {
    return { ...(record as Record<string, unknown>), id };
  }
  return record;
}

function sameRecord(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * @param remoteRecordUpdatedAt 远端 `record_updated_at`（毫秒，缺列时为 0）
 */
export function resolveRemote(
  kind: SyncKind,
  cur: unknown,
  remote: unknown,
  remoteRecordUpdatedAt = 0
): ResolveDecision {
  if (cur === undefined || cur === null) return 'take-remote';

  const localTime = businessTime(cur);
  // 远端还没加 record_updated_at 列时（迁移执行前），用记录自身的业务时间兜底，
  // 否则 0 会恒小于本地时间，远端编辑永远不生效。
  const remoteTime = Number(remoteRecordUpdatedAt) || businessTime(remote);

  if (remoteTime > localTime) return 'take-remote';
  if (remoteTime < localTime) return 'keep-local';

  // 业务时间相等（或两端都缺失）：按类型兜底
  switch (kind) {
    case 'order': {
      const curOrder = cur as SalesOrder;
      const remoteOrder = remote as SalesOrder;
      if (Boolean(curOrder.voided) !== Boolean(remoteOrder.voided)) return 'take-remote';
      if (!sameRecord(normalize(cur, curOrder.id), normalize(remote, curOrder.id))) {
        // 只有双方都有明确业务时间、且完全相同，才视为真冲突；
        // 旧数据（两端都是 0）沿用「流水只增」的保守策略，避免升级后一次性刷出大量待核对。
        return remoteTime > 0 ? 'conflict' : 'keep-local';
      }
      return 'keep-local';
    }
    case 'product': {
      const localUpdated = (cur as Product).updatedAt ?? '';
      const remoteUpdated = (remote as Product).updatedAt ?? '';
      if (remoteUpdated > localUpdated) return 'take-remote';
      return 'keep-local';
    }
    case 'session': {
      const merged = mergeSessionPair(cur as Session, remote as Session);
      return sameRecord(merged, cur) ? 'keep-local' : 'take-remote';
    }
    case 'setting':
      return 'take-remote';
    case 'batch':
    case 'line':
    case 'adjustment':
      return 'keep-local';
    default:
      return 'keep-local';
  }
}

/** 同步失败退避：1s → 2s → 4s → … → 60s；成功后用 0 重置 */
export function nextBackoff(current: number): number {
  if (!Number.isFinite(current) || current <= 0) return 1000;
  return Math.min(Math.round(current) * 2, 60_000);
}