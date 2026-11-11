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
 * 本机「进行中」的场次：`status === 'open'` 且 `deviceId` 属于本机。
 * 异常情况下出现多条时取 `startedAt` 最晚的一场（倒序后取第一个）。
 *
 * 首页与报表页必须指向同一场，所以这条规则只在这里实现一次——
 * 之前两处各写一份，规则一改就会悄悄分叉。
 *
 * 说明：
 * - 入参不会被修改（`filter` 已产出新数组，`sort` 作用在副本上）；
 * - 比较器沿用历史写法（相等时返回 -1），与两处旧实现取 `[0]` 的结果保持一致。
 */
export function pickOpenSession(sessions: Session[], deviceId: string): Session | undefined {
  return sessions
    .filter((s) => s.status === 'open' && s.deviceId === deviceId)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
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