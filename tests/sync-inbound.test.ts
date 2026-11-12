// 同步入站回归锁：删除级联 / 墓碑白名单 / 冲突落库 / pending 跳过 / 推送失败保留 / 回推防回声。
// 脚手架照 tests/sync-unknown-kind.test.ts：假 `fetch` + fake-indexeddb，不联网、不写真实账本。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db/db';
import { enqueue, enqueueMany, pendingCount } from '../src/db/outbox';
import { parseRemoteRecord, syncNow } from '../src/db/sync';
import { makeLine, makeOrder, resetDb, T0 } from './helpers';

const CFG = { url: 'https://example.supabase.co', anonKey: 'anon-key', ledgerKey: 'led-1' };

/** localStorage 替身（Node 环境没有真 localStorage） */
const store = new Map<string, string>();
/** 拉取页队列：每次 GET 消费一页，耗尽后返回空页终止分页 */
let pages: unknown[][];
/** 推送响应状态码队列：耗尽后一律 201 */
let pushStatuses: number[];
/** 实际发出的拉取 URL（不含「清空标记」探针） */
let pullUrls: string[];
/** 每次推送的 payload（批量推送各算一次） */
let pushBodies: Record<string, unknown>[][];
/** 拉取请求往返期间执行一次副作用：用于模拟「推送完成后、拉取途中用户又改了一笔」的竞态 */
let onPull: (() => Promise<void>) | null;
/** 远端的「清空账本」标记值（0 = 没有标记，探针返回空） */
let clearMark: number;

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

/** 远端 order 行（data 走 parseRemoteRecord 的必填校验，字段给全） */
function remoteOrderRow(
  id: string,
  totalFen: number,
  opts: { updatedAt?: string; recordUpdatedAt?: number; insertedAt?: number } = {}
): Record<string, unknown> {
  const updatedAt = opts.updatedAt ?? T0;
  return {
    id: `order:${id}`,
    record_id: id,
    kind: 'order',
    data: {
      id,
      deviceId: 'dev-other',
      operator: '对方',
      createdAt: T0,
      payMethod: 'cash',
      totalFen,
      updatedAt
    },
    updated_at: opts.insertedAt ?? 3000,
    record_updated_at: opts.recordUpdatedAt ?? Date.parse(updatedAt),
    deleted: false
  };
}

beforeEach(async () => {
  await resetDb();
  store.clear();
  pages = [];
  pushStatuses = [];
  pullUrls = [];
  pushBodies = [];
  onPull = null;
  clearMark = 0;

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear()
  });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      // 推送：POST yh_records?on_conflict=id
      if (u.includes('on_conflict')) {
        pushBodies.push(JSON.parse(String(init?.body ?? '[]')) as Record<string, unknown>[]);
        const status = pushStatuses.shift() ?? 201;
        if (status >= 400) return new Response('boom', { status });
        return new Response('', { status: 201 });
      }
      // 「清空账本」标记探针（已有水位时才会发出）：clearMark=0 时当作没有标记，
      // 否则返回标记行，用来测 H1「清空 vs 本地待推送改动」。
      if (u.includes('id=eq.')) {
        if (clearMark > 0) {
          return jsonResponse([
            { id: '__ledger_cleared__:led-1', updated_at: clearMark, data: { clearedAt: clearMark } }
          ]);
        }
        return jsonResponse([]);
      }
      pullUrls.push(u);
      if (onPull) await onPull();
      return jsonResponse(pages.shift() ?? []);
    })
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await resetDb();
});

describe('入站删除（含墓碑白名单）', () => {
  it('pull 收到 deleted 的 order 时连带删除本地明细', async () => {
    await db.orders.put(makeOrder('o1', 1000, 's1'));
    await db.lines.put(makeLine('l1', 'o1', 'p1', 2, 1000));
    await db.lines.put(makeLine('l2', 'o1', 'p2', 1, 500));
    pages = [
      [{ id: 'order:o1', record_id: 'o1', kind: 'order', data: {}, updated_at: 1000, deleted: true }]
    ];

    await syncNow(CFG);

    expect(await db.orders.get('o1')).toBeUndefined();
    expect(await db.lines.where('orderId').equals('o1').count()).toBe(0);
    // 删除是「云端已经发生的事实」，不该反向入队回推
    expect(await pendingCount()).toBe(0);
  });

  it('墓碑删除不删设备级设置，业务设置照删', async () => {
    await db.settings.bulkPut([
      { key: 'deviceId', value: 'dev-aaa' },
      { key: 'deviceName', value: '摊位手机' },
      { key: 'operatorA', value: '小明' }
    ]);
    const tombstone = (key: string) => ({
      id: `setting:${key}`,
      record_id: key,
      kind: 'setting',
      data: {},
      updated_at: 1000,
      deleted: true
    });
    pages = [[tombstone('deviceId'), tombstone('deviceName'), tombstone('operatorA')]];

    await syncNow(CFG);

    // 删掉本机 deviceId 会让 ensureDeviceId 重新生成 UUID，进行中的场次立刻「找不到」
    expect((await db.settings.get('deviceId'))?.value).toBe('dev-aaa');
    expect((await db.settings.get('deviceName'))?.value).toBe('摊位手机');
    expect(await db.settings.get('operatorA')).toBeUndefined();
  });
});

describe('入站冲突', () => {
  it('两端同时间不同内容：写一条冲突留痕且本地值不变', async () => {
    const AT = '2026-11-02T10:00:00.000Z';
    await db.orders.put(makeOrder('o1', 1000, 's1', { updatedAt: AT }));
    pages = [[remoteOrderRow('o1', 2000, { updatedAt: AT, recordUpdatedAt: Date.parse(AT) })]];

    await syncNow(CFG);

    expect(await db.conflicts.count()).toBe(1);
    const row = (await db.conflicts.toArray())[0];
    expect(row.kind).toBe('order');
    expect(row.recordId).toBe('o1');
    expect(Number.isNaN(Date.parse(row.at))).toBe(false);
    expect(JSON.parse(row.local).totalFen).toBe(1000);
    expect(JSON.parse(row.remote).totalFen).toBe(2000);
    // 冲突只留痕，不覆盖本地
    expect((await db.orders.get('o1'))?.totalFen).toBe(1000);
    // 冲突同时登记回推：让云端收敛到本地版本（否则换机重装会看到对方那一版）
    expect(await db.outbox.get('order:o1')).toBeTruthy();
  });
});

describe('入站冲突去重（H2.2）', () => {
  it('同一单连续 3 轮同步：conflicts 只留 1 条，重复冲突原地更新', async () => {
    const AT = '2026-11-02T10:00:00.000Z';
    await db.orders.put(makeOrder('o1', 1000, 's1', { updatedAt: AT }));
    const remote = remoteOrderRow('o1', 2000, { updatedAt: AT, recordUpdatedAt: Date.parse(AT) });
    // 三轮各拉到同一份远端数据（回推不会改变假后端的内容）
    pages = [[remote], [remote], [remote]];

    await syncNow(CFG);
    await syncNow(CFG);
    await syncNow(CFG);

    // 原先每轮 bulkAdd 一行 → 3 条，设置页「待核对 N 条」只增不减
    expect(await db.conflicts.count()).toBe(1);
    const row = (await db.conflicts.toArray())[0];
    expect(row.kind).toBe('order');
    expect(row.recordId).toBe('o1');
    expect(JSON.parse(row.local).totalFen).toBe(1000);
    expect(JSON.parse(row.remote).totalFen).toBe(2000);
    // 冲突只留痕，本地值始终不被覆盖
    expect((await db.orders.get('o1'))?.totalFen).toBe(1000);
  });
});

describe('清空账本 vs 本地待推送改动（H1）', () => {
  /** 远端清空后只剩墓碑：全量重放会据此把本机旧单删掉 */
  const CLEARED_AT = 2000;

  function orderTombstone(id: string): Record<string, unknown> {
    return {
      id: `order:${id}`,
      record_id: id,
      kind: 'order',
      data: {},
      updated_at: CLEARED_AT,
      deleted: true
    };
  }

  /** 已有水位才会打「清空标记」探针（与线上一致） */
  function setWatermark(): void {
    store.set('yh-sync-last-pull', '5000');
    store.set('yh-sync-last-pull-id', 'order:prev');
  }

  it('清空前入队的改动被丢弃：不再推回云端，本地旧单随墓碑删除', async () => {
    await db.orders.put(makeOrder('o1', 1000, 's1'));
    await db.outbox.put({
      id: 'order:o1',
      kind: 'order',
      recordId: 'o1',
      op: 'upsert',
      queuedAt: CLEARED_AT - 1
    });
    setWatermark();
    clearMark = CLEARED_AT;
    pages = [[orderTombstone('o1')]];

    await syncNow(CFG);

    // 关键回归：push 发生在 pull 之前时，这一条会先落云，清空随即被「复活」
    expect(pushBodies).toHaveLength(0);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.orders.get('o1')).toBeUndefined();
    // 丢弃必须留下可排查的诊断
    expect(store.get('yh-sync-warn') ?? '').toContain('清空账本');
  });

  it('清空之后的新改动（queuedAt > clearedAt）照常推送，不被误删', async () => {
    await db.orders.put(makeOrder('o2', 3000, 's1'));
    await db.outbox.put({
      id: 'order:o2',
      kind: 'order',
      recordId: 'o2',
      op: 'upsert',
      queuedAt: CLEARED_AT + 1
    });
    setWatermark();
    clearMark = CLEARED_AT;
    pages = [[]]; // 云端清空后还没有新数据

    await syncNow(CFG);

    expect(pushBodies.flat().some((r) => r.record_id === 'o2')).toBe(true);
    expect(await db.outbox.count()).toBe(0);
    expect((await db.orders.get('o2'))?.totalFen).toBe(3000);
  });
});

describe('入站跳过与保留', () => {
  it('本地有 pending 时 pull 不覆盖本地值', async () => {
    await db.orders.put(makeOrder('o1', 1000, 's1'));
    // 真实竞态：pushOutbox 已经跑完，pull 往返期间用户又改了一笔 → 该 id 重新进发件箱
    onPull = async () => {
      await enqueue('order', 'o1');
    };
    pages = [[remoteOrderRow('o1', 2000, { updatedAt: '2026-11-02T10:00:00.000Z' })]];

    await syncNow(CFG);

    expect((await db.orders.get('o1'))?.totalFen).toBe(1000);
    expect(await db.outbox.get('order:o1')).toBeTruthy();
  });

  it('发件箱积压 301 条时，第一轮不覆盖本地、第二轮补推后能对齐远端', async () => {
    await db.orders.put(makeOrder('o1', 1000, 's1'));
    // 301 条 > OUTBOX_BATCH(300)：第一轮只能推走前 300 条，order:o1 仍留在发件箱里
    const backlog: { kind: 'product' | 'order'; recordId: string }[] = Array.from(
      { length: 300 },
      (_, i) => ({ kind: 'product' as const, recordId: `p${i}` })
    );
    backlog.push({ kind: 'order', recordId: 'o1' });
    await enqueueMany(backlog);
    const remote = remoteOrderRow('o1', 2000, { updatedAt: '2026-11-02T10:00:00.000Z', insertedAt: 5000 });
    pages = [[remote], [remote]];

    await syncNow(CFG);
    expect(await pendingCount()).toBe(1);
    expect((await db.orders.get('o1'))?.totalFen).toBe(1000);
    // 被跳过的远端行没有永久丢在水位以下：第一轮游标落在 5000，
    // 第二轮请求起点经 5 分钟重叠窗口回退后被夹到 0 → 从头发一遍，该行重新送达。
    // （第二轮若按严格复合游标 `or=(updated_at.gt.5000,...)` 请求，这一行就永久丢了。）
    expect(new URL(pullUrls[0]).searchParams.get('or')).toBeNull();

    await syncNow(CFG);
    expect(new URL(pullUrls[1]).searchParams.get('updated_at')).toBeNull();
    expect(new URL(pullUrls[1]).searchParams.get('or')).toBeNull();
    expect(await pendingCount()).toBe(0);
    expect((await db.orders.get('o1'))?.totalFen).toBe(2000);
  });

  it('推送 500 时发件箱不清空，重试成功后清空', async () => {
    await db.orders.put(makeOrder('o1', 1000, 's1'));
    await enqueue('order', 'o1');
    pushStatuses = [500, 201];

    await expect(syncNow(CFG)).rejects.toThrow(/Supabase 500/);

    expect(await pendingCount()).toBe(1);
    expect(store.get('yh-sync-last-sync')).toBeUndefined();
    // 断网/失败不丢单：本地记录必须还在
    expect((await db.orders.get('o1'))?.totalFen).toBe(1000);

    await syncNow(CFG);
    expect(await pendingCount()).toBe(0);
  });
});

describe('回推与防回声', () => {
  // 回推节流表（30s）是 sync.ts 的模块级状态：现在由 tests/setup.ts 的 afterEach
  // 调用 `__resetSyncFlagsForTest()` 兜底复位，用例之间不会再互相节流。
  // 这里仍然给每个用例分配各自的 recordId —— 只为可读性（断言里一眼能看出是哪条记录）。
  it('远端是对方旧版本时重新入队回推，且本地值不变', async () => {
    const LOCAL_AT = '2026-11-02T10:00:00.000Z';
    const localMs = Date.parse(LOCAL_AT);
    await db.orders.put(makeOrder('r1', 1000, 's1', { updatedAt: LOCAL_AT }));
    pages = [
      [
        remoteOrderRow('r1', 999, {
          updatedAt: '2026-11-01T10:00:00.000Z',
          recordUpdatedAt: localMs - 60_000,
          insertedAt: 4000
        })
      ]
    ];

    await syncNow(CFG);

    expect((await db.orders.get('r1'))?.totalFen).toBe(1000);
    expect(await db.outbox.get('order:r1')).toBeTruthy();
  });

  it('远端就是本地刚推上去的回声时不重复入队、也不写冲突', async () => {
    const AT = '2026-11-02T10:00:00.000Z';
    const local = makeOrder('e1', 1000, 's1', { updatedAt: AT });
    await db.orders.put(local);
    // 比较口径是键序无关的 canonicalJson（H2.1），所以这里即使键序与 makeOrder 不同，
    // 也必须判成「内容相同」—— 否则回声会被当成冲突或回推候选。
    const echo = {
      id: 'e1',
      deviceId: local.deviceId,
      operator: local.operator,
      createdAt: local.createdAt,
      payMethod: local.payMethod,
      totalFen: local.totalFen,
      sessionId: local.sessionId,
      updatedAt: AT
    };
    pages = [
      [{ ...remoteOrderRow('e1', 1000, { updatedAt: AT, insertedAt: 5000 }), data: echo }]
    ];

    await syncNow(CFG);

    // 内容相同 → 连回推候选都不该登记（30s 节流之外的第二道闸门）
    expect(await pendingCount()).toBe(0);
    expect(await db.conflicts.count()).toBe(0);
    expect((await db.orders.get('e1'))?.totalFen).toBe(1000);
  });

  /**
   * M-1：重放轮必须回推。
   *
   * 增量轮只回看「游标 − 5 分钟」，更早被对方用旧版本覆盖的行只有每日重放能看到；
   * 重放轮若整轮禁推，这些记录就永远停在云端旧值（换机重装即丢）。
   */
  it('每日重放轮也会回推 5 分钟窗口外的 keep-local 行', async () => {
    const LOCAL_AT = '2026-11-02T10:00:00.000Z';
    const localMs = Date.parse(LOCAL_AT);
    await db.orders.put(makeOrder('r9', 1000, 's1', { updatedAt: LOCAL_AT }));
    // 已有水位 → 本轮不是 replayAll，增量轮之后会叠一轮每日重放
    store.set('yh-sync-last-pull', '10000000');
    store.set('yh-sync-last-pull-id', 'order:prev');
    pages = [
      // 增量轮（gte 9700000）什么都没拉到
      [],
      // 重放轮（从 0 起）：这行的 updated_at=4000 远早于增量窗口，只有重放能看见
      [
        remoteOrderRow('r9', 999, {
          updatedAt: '2026-11-01T10:00:00.000Z',
          recordUpdatedAt: localMs - 60_000,
          insertedAt: 4000
        })
      ]
    ];

    await syncNow(CFG);

    // 增量轮确实只回看了 5 分钟，没看到这条
    expect(new URL(pullUrls[0]).searchParams.get('updated_at')).toBe('gte.9700000');
    // 重放轮读到了并且回推：云端会向本地收敛
    expect(await db.outbox.get('order:r9')).toBeTruthy();
    expect((await db.orders.get('r9'))?.totalFen).toBe(1000);
    // 重放轮不重复记冲突（这条已经判过 keep-local，冲突留痕由增量轮负责）
    expect(await db.conflicts.count()).toBe(0);
  });
});

describe('重放轮与 pending 的交互', () => {
  /**
   * 重放会把已应用过的行再走一遍，但**本地还有待推送改动**的记录不能被远端旧值覆盖；
   * 也不能因为「回推」再入队一次（发件箱本来就有一条）。
   */
  it('每日重放轮同样跳过 pending 行：不覆盖本地、不重复入队、不写冲突', async () => {
    await db.orders.put(makeOrder('p1', 1000, 's1'));
    // 真实竞态：推送跑完之后、拉取往返期间用户又改了一笔 → 该 id 处于 pending。
    // （如果一开始就入队，syncNow 的推送会先把它推走，pull 时就测不到 pending 分支了）
    onPull = async () => {
      await enqueue('order', 'p1');
    };
    store.set('yh-sync-last-pull', '10000000');
    store.set('yh-sync-last-pull-id', 'order:prev');
    pages = [
      [],
      [
        remoteOrderRow('p1', 2000, {
          updatedAt: '2026-11-02T10:00:00.000Z',
          insertedAt: 4000
        })
      ]
    ];

    await syncNow(CFG);

    // 增量轮与重放轮都必须让本地待推送的版本胜出
    expect((await db.orders.get('p1'))?.totalFen).toBe(1000);
    expect(await pendingCount()).toBe(1);
    expect(await db.conflicts.count()).toBe(0);
  });
});

describe('未知枚举值（前向兼容）', () => {
  /** M-3：新版本可能新增分类值，旧客户端不能因此整行丢弃这条记录 */
  it('未知分类值保留原值并记诊断，不整行丢弃', async () => {
    pages = [
      [
        {
          id: 'product:p9',
          record_id: 'p9',
          kind: 'product',
          data: {
            id: 'p9',
            name: '礼花弹 100 发',
            category: '礼花弹',
            unitBase: '个',
            boxQty: 1,
            priceList: 9900,
            negotiable: false,
            archived: false,
            sortOrder: 0,
            createdAt: T0,
            updatedAt: T0
          },
          updated_at: 1000,
          record_updated_at: Date.parse(T0),
          deleted: false
        }
      ]
    ];

    await syncNow(CFG);

    const row = await db.products.get('p9');
    expect(row).toBeTruthy();
    // 值域外的分类原样保留（旧客户端不认识的取值也不能丢数据）
    expect(String(row?.category)).toBe('礼花弹');
    expect(row?.priceList).toBe(9900);
    // 诊断要能被排查到
    expect(store.get('yh-sync-warn') ?? '').toContain('未知取值');
  });
});

describe('孤儿明细（M-4）', () => {
  /**
   * order 墓碑与「更晚的 line 行」可能落在不同批次：父单已删时不能把明细写回来，
   * 但同一批里一起到达的 order + line 必须正常写入（首次全量的常见形态）。
   */
  it('父单已删除的明细不写回；同批到达的父单与明细正常写入', async () => {
    pages = [
      [
        {
          id: 'order:o2',
          record_id: 'o2',
          kind: 'order',
          data: {
            id: 'o2',
            deviceId: 'dev-other',
            operator: '对方',
            createdAt: T0,
            payMethod: 'cash',
            totalFen: 100,
            updatedAt: T0
          },
          updated_at: 1000,
          record_updated_at: Date.parse(T0),
          deleted: false
        },
        {
          id: 'line:l2',
          record_id: 'l2',
          kind: 'line',
          data: { orderId: 'o2', productId: 'p1', qtyBase: 1, amountFen: 100 },
          updated_at: 1001,
          record_updated_at: Date.parse(T0),
          deleted: false
        },
        {
          // 父单本地已不存在（墓碑先到 / 另一台设备更晚的编辑）：这条必须被丢弃
          id: 'line:l9',
          record_id: 'l9',
          kind: 'line',
          data: { orderId: 'gone', productId: 'p1', qtyBase: 1, amountFen: 100 },
          updated_at: 1002,
          record_updated_at: Date.parse(T0),
          deleted: false
        }
      ]
    ];

    await syncNow(CFG);

    expect(await db.orders.get('o2')).toBeTruthy();
    expect(await db.lines.get('l2')).toBeTruthy();
    expect(await db.lines.get('l9')).toBeUndefined();
    expect(store.get('yh-sync-warn') ?? '').toContain('孤立明细');
  });
});

describe('parseRemoteRecord 入站校验', () => {
  const cases: { name: string; kind: string; data: unknown }[] = [
    { name: 'data 为 null', kind: 'order', data: null },
    { name: 'data 为数组（展开会把下标当字段）', kind: 'order', data: [{ totalFen: 1 }] },
    { name: 'data 为字符串（展开会拆成字符）', kind: 'order', data: 'not-an-object' },
    { name: 'data 为数字', kind: 'order', data: 1 },
    { name: '金额字段是字符串', kind: 'order', data: { deviceId: 'd', operator: '我', createdAt: T0, payMethod: 'cash', totalFen: 'abc' } },
    { name: '数量字段是 NaN', kind: 'line', data: { orderId: 'o1', productId: 'p1', qtyBase: Number.NaN, amountFen: 100 } },
    { name: '数量字段为 0（下限口径）', kind: 'line', data: { orderId: 'o1', productId: 'p1', qtyBase: 0, amountFen: 100 } },
    { name: '枚举字段是数字（类型错仍拒绝）', kind: 'order', data: { deviceId: 'd', operator: '我', createdAt: T0, payMethod: 1, totalFen: 100 } },
    { name: '必填字段缺失', kind: 'product', data: { name: '大地红' } }
  ];

  for (const c of cases) {
    it(`拒绝非法远端行：${c.name}`, () => {
      expect(parseRemoteRecord(c.kind as never, c.data)).toBeNull();
    });
  }

  it('合法远端行原样接受', () => {
    const order = {
      deviceId: 'dev-other',
      operator: '对方',
      createdAt: T0,
      payMethod: 'cash',
      totalFen: 2500
    };
    expect(parseRemoteRecord('order', order)).toEqual(order);
    expect(
      parseRemoteRecord('line', { orderId: 'o1', productId: 'p1', qtyBase: 2, amountFen: 500 })
    ).not.toBeNull();
  });
});