// 场次纯逻辑：分组与合并决策。不碰 Dexie，方便单测。

import type { SalesOrder, Session } from './types';
import { isoToLocalDate } from './util';

/** 同一场相邻两单允许的最大间隔；超过视为收摊后重新开张 */
export const SESSION_GAP_MS = 4 * 60 * 60 * 1000;

/**
 * 历史订单 → 场次分组。
 * 规则：按本地自然日分组；同一天内相邻两单间隔 > gapMs 切分。
 */
export function groupOrdersBySession(
  orders: SalesOrder[],
  gapMs: number = SESSION_GAP_MS
): SalesOrder[][] {
  const sorted = [...orders].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const groups: SalesOrder[][] = [];
  let groupDay = '';
  let lastTs = 0;

  for (const o of sorted) {
    const ts = Date.parse(o.createdAt) || 0;
    const day = isoToLocalDate(o.createdAt);
    if (groups.length === 0 || day !== groupDay || ts - lastTs > gapMs) {
      groups.push([o]);
      groupDay = day;
    } else {
      groups[groups.length - 1].push(o);
    }
    lastTs = ts;
  }
  return groups;
}

/**
 * 两台设备 / 备份合并时的场次冲突决策：
 * 1. closed 优先于 open（避免已结账场次被拉回进行中）
 * 2. 同状态取 updatedAt 新者
 * 3. 补记计数取 max（同一补记单按 UUID 去重，不累加）
 */
export function mergeSessionPair(cur: Session, incoming: Session): Session {
  const incClosed = incoming.status === 'closed';
  const curClosed = cur.status === 'closed';
  const winner =
    incClosed !== curClosed
      ? incClosed
        ? incoming
        : cur
      : (incoming.updatedAt ?? '') >= (cur.updatedAt ?? '')
        ? incoming
        : cur;

  return {
    ...winner,
    patchedCount: Math.max(cur.patchedCount ?? 0, incoming.patchedCount ?? 0)
  };
}