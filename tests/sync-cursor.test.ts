import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db/db';
import { enqueue, pendingCount } from '../src/db/outbox';
import { buildPullParams, getSyncConfig, nextCursor, pullStartCursor, syncNow } from '../src/db/sync';
import { DEFAULT_SYNC } from '../src/db/syncDefaults';
import { makeOrder, resetDb } from './helpers';

const store = new Map<string, string>();
let getPages: unknown[][] = [];
const getUrls: string[] = [];
/** 每次推送的 payload（批量推送各算一次），用于断言去列降级后的 body */
const pushPayloads: Record<string, unknown>[][] = [];
/** 推送响应状态码队列：耗尽后一律 201 */
let pushStatuses: number[] = [];
/** 推送错误响应体队列（与 pushStatuses 配合，用于 PGRST204 文本） */
let pushErrorTexts: string[] = [];
/** 非 null 时下一次推送直接抛这个异常（模拟断网 / DNS 失败） */
let pushNetworkError: Error | null = null;
/** 拉取请求要注入的异常队列：在返回响应之前抛出，用于模拟 PostgREST 缺列错误 */
let pullErrors: Error[] = [];

/**
 * 假 Supabase：
 * - `on_conflict` 是推送；`id=eq.` 是「清空账本」标记探针（有水位时才发，一律返回空数组，
 *   否则它会消费页队列、让后面的断言整体错位）；其余 GET 按队列返回一页。
 * - 缺列降级用例需要「先失败再成功」，所以推送/拉取都留了可注入的错误队列。
 */
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const u = String(url);
  if (u.includes('on_conflict')) {
    // 先记下「尝试过的 body」，再决定抛错/返回状态：重试次数与 request body 都要能断言
    pushPayloads.push(JSON.parse(String(init?.body ?? '[]')) as Record<string, unknown>[]);
    if (pushNetworkError) {
      const e = pushNetworkError;
      pushNetworkError = null;
      throw e;
    }
    const status = pushStatuses.shift() ?? 201;
    if (status >= 400) return new Response(pushErrorTexts.shift() ?? 'boom', { status });
    return new Response('', { status: 201 });
  }
  if (u.includes('id=eq.')) {
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  // 先记录「尝试过的 URL」，再抛错：降级用例要能断言第一次用的是哪套列清单
  getUrls.push(u);
  const thrown = pullErrors.shift();
  if (thrown) throw thrown;
  const page = getPages.shift() ?? [];
  return new Response(JSON.stringify(page), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
});

beforeEach(async () => {
  await resetDb();
  store.clear();
  getPages = [];
  getUrls.length = 0;
  pushPayloads.length = 0;
  pushStatuses = [];
  pushErrorTexts = [];
  pushNetworkError = null;
  pullErrors = [];
  fetchMock.mockClear();

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear()
  });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const CFG = { url: 'https://example.supabase.co', anonKey: 'anon', ledgerKey: 'led-1' };

function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('pull 游标构造', () => {
  it('首次全量不带游标条件，用显式列而不是 *', () => {
    const p = buildPullParams({ ts: 0, id: '' }, 'led-1', 500);

    expect(p.get('ledger')).toBe('eq.led-1');
    expect(p.get('limit')).toBe('500');
    expect(p.get('order')).toBe('updated_at.asc,id.asc');
    expect(p.get('updated_at')).toBeNull();
    expect(p.get('or')).toBeNull();
    expect(p.get('select')).toBe(
      'id,record_id,kind,data,updated_at,record_updated_at,deleted'
    );
    expect(p.get('select')).not.toBe('*');
  });

  it('旧版本升级上来（没有 id 水位）用 gte 重放该毫秒，不丢一轮数据', () => {
    const p = buildPullParams({ ts: 1700000000123, id: '' }, 'led-1', 500);

    expect(p.get('updated_at')).toBe('gte.1700000000123');
    expect(p.get('or')).toBeNull();
  });

  it('有 id 水位时用 (updated_at, id) 复合游标', () => {
    const p = buildPullParams({ ts: 1700000000123, id: 'order:o1' }, 'led-1', 500);

    expect(p.get('updated_at')).toBeNull();
    expect(p.get('or')).toBe(
      '(updated_at.gt.1700000000123,and(updated_at.eq.1700000000123,id.gt.order:o1))'
    );
  });
});

describe('pull 游标推进', () => {
  it('本页首尾同一毫秒：取尾部 id，下一轮只跳过已拉过的行', () => {
    const rows = [
      { id: 'order:a', updated_at: 5000 },
      { id: 'order:b', updated_at: 5000 },
      { id: 'order:c', updated_at: 5000 }
    ];
    const cursor = nextCursor(rows, { ts: 5000, id: '' });

    expect(cursor).toEqual({ ts: 5000, id: 'order:c' });
    expect(buildPullParams(cursor, 'led-1').get('or')).toBe(
      '(updated_at.gt.5000,and(updated_at.eq.5000,id.gt.order:c))'
    );
  });

  it('跨页时间戳递增：游标跟着尾部走', () => {
    const cursor = nextCursor(
      [
        { id: 'order:a', updated_at: 5000 },
        { id: 'order:b', updated_at: 6000 }
      ],
      { ts: 4000, id: 'order:z' }
    );

    expect(cursor).toEqual({ ts: 6000, id: 'order:b' });
  });

  it('空页保持原游标；服务端乱序导致的时间回退不采纳', () => {
    expect(nextCursor([], { ts: 9000, id: 'order:x' })).toEqual({ ts: 9000, id: 'order:x' });
    expect(
      nextCursor([{ id: 'order:old', updated_at: 100 }], { ts: 9000, id: 'order:x' })
    ).toEqual({ ts: 9000, id: 'order:x' });
  });

  it('同一毫秒内 id 比游标更小（服务端乱序）也不采纳，避免游标倒退重复拉同一页', () => {
    expect(
      nextCursor([{ id: 'order:a', updated_at: 5000 }], { ts: 5000, id: 'order:c' })
    ).toEqual({ ts: 5000, id: 'order:c' });
  });

  it('同一毫秒内 id 等于游标：原样返回，不前移也不倒退', () => {
    expect(
      nextCursor([{ id: 'order:c', updated_at: 5000 }], { ts: 5000, id: 'order:c' })
    ).toEqual({ ts: 5000, id: 'order:c' });
  });
});

describe('pull 端到端（假 Supabase）', () => {
  it('整页同毫秒时，第二页请求带复合游标，水位两个键一起推进', async () => {
    const page = Array.from({ length: 500 }, (_, i) => ({
      id: `mystery:${String(i).padStart(3, '0')}`,
      record_id: String(i),
      kind: 'mystery',
      data: {},
      updated_at: 7777,
      deleted: false
    }));
    getPages = [page, []];

    const result = await syncNow(CFG);

    expect(result.pulled).toBe(500);
    expect(getUrls).toHaveLength(2);
    expect(params(getUrls[0]).get('or')).toBeNull();
    expect(params(getUrls[1]).get('or')).toBe(
      '(updated_at.gt.7777,and(updated_at.eq.7777,id.gt.mystery:499))'
    );
    // 旧键继续写时间水位，新键存 id，两个键一起构成游标
    expect(store.get('yh-sync-last-pull')).toBe('7777');
    expect(store.get('yh-sync-last-pull-id')).toBe('mystery:499');
  });
});

describe('拉取起点与重叠窗口', () => {
  it('首轮起点回退 5 分钟；cursor=0 时原样返回', () => {
    // 首次/清空后全量重放：起点仍是 0，不会变成负数
    expect(pullStartCursor({ ts: 0, id: '' })).toEqual({ ts: 0, id: '' });
    // 水位不足 5 分钟：回退后夹到 0
    expect(pullStartCursor({ ts: 100000, id: 'x' })).toEqual({ ts: 0, id: '' });
    // 正常水位：回退 300000ms 并把 id 置空（退化成 gte，重放边界整毫秒）
    expect(pullStartCursor({ ts: 10000000, id: 'x' })).toEqual({
      ts: 10000000 - 300000,
      id: ''
    });
  });

  it('重叠窗口只作用于请求起点，持久化水位仍按真实行尾推进', async () => {
    store.set('yh-sync-last-pull', '10000000');
    store.set('yh-sync-last-pull-id', 'order:prev');
    getPages = [
      [
        {
          id: 'order:a',
          record_id: 'a',
          kind: 'order',
          data: {
            id: 'a',
            deviceId: 'dev-other',
            operator: '对方',
            createdAt: '2026-11-01T10:00:00.000Z',
            payMethod: 'cash',
            totalFen: 100
          },
          updated_at: 10000001,
          deleted: false
        }
      ]
    ];

    await syncNow(CFG);

    // 请求侧：起点回退 5 分钟，退化为 gte 重放
    expect(params(getUrls[0]).get('updated_at')).toBe('gte.9700000');
    expect(params(getUrls[0]).get('or')).toBeNull();
    // 持久化侧：只收真实行尾，绝不能把回退值写回游标（否则永远推进不了）
    expect(store.get('yh-sync-last-pull')).toBe('10000001');
    expect(store.get('yh-sync-last-pull-id')).toBe('order:a');
  });
});

describe('每日重放的 capped 判定（H-1）', () => {
  const BASE = 1_700_000_000_000;

  /** 20 页 × 500 行的远端行；unknown kind → 不进业务表，用例只验证分页/标记逻辑 */
  function fullLedger(): unknown[][] {
    const out: unknown[][] = [];
    for (let p = 0; p < 20; p++) {
      out.push(
        Array.from({ length: 500 }, (_, i) => {
          const n = p * 500 + i;
          return {
            id: `mystery:r${String(n).padStart(5, '0')}`,
            record_id: `r${n}`,
            kind: 'mystery',
            data: {},
            updated_at: BASE + n,
            deleted: false
          };
        })
      );
    }
    return out;
  }

  it('恰好 MAX_PAGES×PAGE_SIZE 行：探测页为空 → 落今日标记，下一轮不再从 0 重放', async () => {
    getPages = [...fullLedger(), []];
    await syncNow(CFG);

    // 20 页整页 + 1 次 limit=1 探测
    expect(getUrls.filter((u) => params(u).get('limit') === '1')).toHaveLength(1);
    // 探测确认后面没有数据 → 不算 capped，今日重放标记必须落地
    // （否则账本一旦恰好 1 万行，每轮同步都会从 0 重放 20 页）
    expect(store.get('yh-sync-last-replay')).toBeTruthy();
    expect(store.get('yh-sync-last-replay-cursor')).toBeUndefined();
    expect(getUrls).toHaveLength(21);

    // 第二轮：从水位续拉一次空页即结束，不再回 0
    getPages = [];
    const before = getUrls.length;
    await syncNow(CFG);
    expect(getUrls.length - before).toBe(1);
    const second = params(getUrls[before]);
    expect(second.get('updated_at')).toBe(`gte.${BASE + 9999 - 300000}`);
    expect(second.get('or')).toBeNull();
  });

  it('探测页还有数据：判 capped 并落续扫游标，下一轮从那继续而不是回 0', async () => {
    getPages = [
      ...fullLedger(),
      [
        {
          id: 'mystery:r99999',
          record_id: 'r99999',
          kind: 'mystery',
          data: {},
          updated_at: BASE + 100000,
          deleted: false
        }
      ]
    ];
    await syncNow(CFG);

    // 还有后续 → 今天不能算「已校对完」，但也不能把续扫点丢了
    expect(store.get('yh-sync-last-replay')).toBeUndefined();
    const cursor = JSON.parse(store.get('yh-sync-last-replay-cursor') ?? '{}') as {
      ts?: number;
    };
    expect(cursor.ts).toBe(BASE + 9999);

    // 下一轮必须从续扫点接着扫，而不是从 0 重来（否则每次都白扫前 1 万行）
    getPages = [];
    const before = getUrls.length;
    await syncNow(CFG);
    const urls = getUrls.slice(before);
    expect(urls).toHaveLength(2); // 增量轮 + 重放轮
    for (const u of urls) {
      expect(params(u).get('updated_at')).toBe(`gte.${BASE + 9999 - 300000}`);
    }
    // 扫到尾之后标记才落地，续扫游标清掉
    expect(store.get('yh-sync-last-replay')).toBeTruthy();
    expect(store.get('yh-sync-last-replay-cursor')).toBeUndefined();
  });
});

describe('离线与红线开关', () => {
  it('离线时 syncNow 抛「当前离线」且不动水位与发件箱', async () => {
    await db.orders.put(makeOrder('o1', 1000, 's1'));
    await enqueue('order', 'o1');
    vi.stubGlobal('navigator', { onLine: false });

    await expect(syncNow(CFG)).rejects.toThrow('当前离线');

    // 断网不阻断开单：本地写入与发件箱都保留，一个请求都不发
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.get('yh-sync-last-pull')).toBeUndefined();
    expect(store.get('yh-sync-last-sync')).toBeUndefined();
    expect(await pendingCount()).toBe(1);
  });

  it('恢复在线后同一批发件箱能正常推送', async () => {
    await db.orders.put(makeOrder('o1', 1000, 's1'));
    await enqueue('order', 'o1');

    const result = await syncNow(CFG);

    expect(result.pushed).toBe(1);
    expect(await pendingCount()).toBe(0);
  });

  it('yh-sync-disabled=1 时 getSyncConfig 返回 null（测试数据不写真实账本的闸门）', () => {
    store.set('yh-sync-disabled', '1');
    expect(getSyncConfig()).toBeNull();

    // 解除禁用后回落到内置默认配置：零设置即可同步
    store.delete('yh-sync-disabled');
    expect(getSyncConfig()).toEqual({
      url: DEFAULT_SYNC.url,
      anonKey: DEFAULT_SYNC.anonKey,
      ledgerKey: DEFAULT_SYNC.ledgerKey
    });
  });
});

describe('schema 缺列降级重试（M2）', () => {
  const PULL_SELECT = 'id,record_id,kind,data,updated_at,record_updated_at,deleted';
  const PULL_SELECT_LEGACY = 'id,record_id,kind,data,updated_at,deleted';
  /** PostgREST 报「schema cache 里找不到该列」：Postgres 42703 / PGRST204 两种文本都要能被识别 */
  const MISSING_RECORD_COL =
    '{"code":"PGRST204","message":"Could not find the \'record_updated_at\' column of \'yh_records\' in the schema cache"}';

  const orderRow = (id: string) => ({
    id: `order:${id}`,
    record_id: id,
    kind: 'order',
    data: {
      id,
      deviceId: 'dev-other',
      operator: '对方',
      createdAt: '2026-11-01T10:00:00.000Z',
      payMethod: 'cash',
      totalFen: 100
    },
    updated_at: 9000,
    deleted: false
  });

  it('推送遇到 PGRST204 缺 record_updated_at 时去列重试一次，第二次请求不再带该列', async () => {
    await db.orders.put(makeOrder('o1', 1000, 's1'));
    await enqueue('order', 'o1');
    pushStatuses = [400];
    pushErrorTexts = [MISSING_RECORD_COL];

    await syncNow(CFG);

    // 推送共 2 次（拉取请求不计入 pushPayloads）：第一次带列被 400 拒，第二次去列成功
    expect(pushPayloads).toHaveLength(2);
    expect(pushPayloads[0][0]).toHaveProperty('record_updated_at');
    expect(pushPayloads[1][0]).not.toHaveProperty('record_updated_at');
    // 只去掉缺的那一列，schema_version 仍然保留
    expect(pushPayloads[1][0]).toHaveProperty('schema_version', 2);
    expect(await pendingCount()).toBe(0);
    // 降级标志对拉取侧同样生效：同一轮的 pull 已经改用 legacy 列清单
    expect(params(getUrls[0]).get('select')).toBe(PULL_SELECT_LEGACY);
  });

  it('已降级后再次推送不再带 record_updated_at，也不再先撞一次 400', async () => {
    await db.orders.put(makeOrder('o1', 1000, 's1'));
    await enqueue('order', 'o1');
    pushStatuses = [400];
    pushErrorTexts = [MISSING_RECORD_COL];
    await syncNow(CFG);

    // 第二轮：标志已置位，payload 直接省掉该列
    pushPayloads.length = 0;
    await db.orders.put(makeOrder('o2', 1000, 's1'));
    await enqueue('order', 'o2');
    await syncNow(CFG);

    expect(pushPayloads).toHaveLength(1);
    expect(pushPayloads[0][0]).not.toHaveProperty('record_updated_at');
    expect(await pendingCount()).toBe(0);
  });

  it('纯网络错误不做降级：只发一次推送并原样上抛', async () => {
    await db.orders.put(makeOrder('o1', 1000, 's1'));
    await enqueue('order', 'o1');
    pushNetworkError = new Error('Failed to fetch');

    await expect(syncNow(CFG)).rejects.toThrow('Failed to fetch');

    // 只尝试了一次，没有把「Failed to fetch」当成缺列去重试
    expect(pushPayloads).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await pendingCount()).toBe(1);
    // 推送就失败了，拉取根本没跑
    expect(getUrls).toHaveLength(0);
    expect(store.get('yh-sync-last-pull')).toBeUndefined();
  });

  it('拉取遇到 42703 时降级为 legacy 列清单且只重试一次', async () => {
    pullErrors = [
      new Error(
        'Supabase 400: {"code":"42703","message":"column yh_records.record_updated_at does not exist"}'
      )
    ];
    getPages = [[orderRow('a')]];

    const result = await syncNow(CFG);

    expect(getUrls).toHaveLength(2);
    expect(params(getUrls[0]).get('select')).toBe(PULL_SELECT);
    expect(params(getUrls[1]).get('select')).toBe(PULL_SELECT_LEGACY);
    // 重试拿到数据即停：没有第三次请求
    expect(result.pulled).toBe(1);
    expect((await db.orders.get('a'))?.totalFen).toBe(100);
  });

  it('降级后再拉一轮直接用 legacy 列清单，不再先撞 400', async () => {
    pullErrors = [
      new Error(
        'Supabase 400: {"code":"PGRST204","message":"column yh_records.record_updated_at does not exist in schema cache"}'
      )
    ];
    getPages = [[], []];
    // 第一轮：撞缺列 → 置位 → 重试（空页）
    await syncNow(CFG);

    getUrls.length = 0;
    await syncNow(CFG);

    expect(getUrls).toHaveLength(1);
    expect(params(getUrls[0]).get('select')).toBe(PULL_SELECT_LEGACY);
  });
});