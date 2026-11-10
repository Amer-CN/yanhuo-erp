import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPullParams, nextCursor, syncNow } from '../src/db/sync';
import { resetDb } from './helpers';

const store = new Map<string, string>();
let getPages: unknown[][] = [];
const getUrls: string[] = [];

beforeEach(async () => {
  await resetDb();
  store.clear();
  getPages = [];
  getUrls.length = 0;

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear()
  });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      getUrls.push(String(url));
      const page = getPages.shift() ?? [];
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    })
  );
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