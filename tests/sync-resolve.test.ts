import { describe, expect, it } from 'vitest';
import {
  businessTime,
  nextBackoff,
  resolveRemote,
  type ResolveDecision,
  type SyncKind
} from '../src/db/syncResolve';
import { makeBatch, makeOrder, makeProduct, makeSession } from './helpers';

const T = '2026-11-01T10:00:00.000Z';
const T_MS = Date.parse(T);

describe('resolveRemote（表驱动）', () => {
  const localOrder = makeOrder('o1', 1000, 's1', { updatedAt: T });
  const remoteEdited = makeOrder('o1', 2000, 's1', { updatedAt: T });

  const cases: {
    name: string;
    kind: SyncKind;
    local: unknown;
    remote: unknown;
    remoteTime: number;
    want: ResolveDecision;
  }[] = [
    {
      name: '本地没有 → 取远端',
      kind: 'order',
      local: undefined,
      remote: remoteEdited,
      remoteTime: T_MS,
      want: 'take-remote'
    },
    {
      name: '远端业务时间更新 → 取远端（修复「编辑永不同步」）',
      kind: 'order',
      local: localOrder,
      remote: remoteEdited,
      remoteTime: T_MS + 1000,
      want: 'take-remote'
    },
    {
      name: '远端业务时间更旧 → 保留本地',
      kind: 'order',
      local: localOrder,
      remote: remoteEdited,
      remoteTime: T_MS - 1000,
      want: 'keep-local'
    },
    {
      name: '时间相同、作废状态相同、内容不同 → 冲突留痕',
      kind: 'order',
      local: localOrder,
      remote: remoteEdited,
      remoteTime: T_MS,
      want: 'conflict'
    },
    {
      name: '时间相同、作废状态不同 → 取远端（作废是明确动作）',
      kind: 'order',
      local: localOrder,
      remote: { ...localOrder, voided: true },
      remoteTime: T_MS,
      want: 'take-remote'
    },
    {
      name: '两端都缺业务时间（旧数据）→ 保留本地，不刷冲突',
      kind: 'order',
      local: { ...localOrder, updatedAt: undefined },
      remote: { ...remoteEdited, updatedAt: undefined },
      remoteTime: 0,
      want: 'keep-local'
    },
    {
      name: 'product：时间相同但远端 updatedAt 更新 → 取远端',
      kind: 'product',
      local: makeProduct('p1', { updatedAt: T }),
      remote: makeProduct('p1', { updatedAt: '2026-11-02T00:00:00.000Z' }),
      remoteTime: T_MS,
      want: 'take-remote'
    },
    {
      name: 'product：updatedAt 相同 → 保留本地',
      kind: 'product',
      local: makeProduct('p1', { updatedAt: T }),
      remote: makeProduct('p1', { updatedAt: T }),
      remoteTime: T_MS,
      want: 'keep-local'
    },
    {
      name: 'session：远端已结账且补记更多 → 取合并结果',
      kind: 'session',
      local: makeSession('s1', { status: 'open', patchedCount: 0, updatedAt: T }),
      remote: makeSession('s1', { status: 'closed', patchedCount: 3, updatedAt: T }),
      remoteTime: T_MS,
      want: 'take-remote'
    },
    {
      name: 'batch：同 id 只增不改',
      kind: 'batch',
      local: makeBatch('b1', 'p1', 5, 100),
      remote: makeBatch('b1', 'p1', 99, 900),
      remoteTime: T_MS,
      want: 'keep-local'
    },
    {
      name: 'setting：远端覆盖',
      kind: 'setting',
      local: { key: 'operatorA', value: '我' },
      remote: { key: 'operatorA', value: '老婆' },
      remoteTime: T_MS,
      want: 'take-remote'
    }
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(resolveRemote(c.kind, c.local, c.remote, c.remoteTime)).toBe(c.want);
    });
  }
});

describe('businessTime', () => {
  it('优先 updatedAt，其次 createdAt / startedAt，非法值为 0', () => {
    expect(businessTime({ updatedAt: '2026-11-02T00:00:00.000Z', createdAt: T })).toBe(
      Date.parse('2026-11-02T00:00:00.000Z')
    );
    expect(businessTime({ createdAt: T })).toBe(T_MS);
    expect(businessTime({ startedAt: T })).toBe(T_MS);
    expect(businessTime({ updatedAt: 'not-a-date' })).toBe(0);
    expect(businessTime(null)).toBe(0);
  });
});

describe('nextBackoff', () => {
  it('1s → 2s → 4s … 上限 60s；成功后重置', () => {
    expect(nextBackoff(0)).toBe(1000);
    expect(nextBackoff(1000)).toBe(2000);
    expect(nextBackoff(2000)).toBe(4000);
    expect(nextBackoff(32000)).toBe(60000);
    expect(nextBackoff(60000)).toBe(60000);
    expect(nextBackoff(-5)).toBe(1000);
  });
});