import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db/db';
import { enqueue } from '../src/db/outbox';
import { syncNow } from '../src/db/sync';
import { makeProduct, resetDb } from './helpers';

const store = new Map<string, string>();
const posts: Record<string, unknown>[][] = [];
let getRows: unknown[] = [];

beforeEach(async () => {
  await resetDb();
  store.clear();
  posts.length = 0;
  getRows = [];

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
      if (String(url).includes('on_conflict')) {
        posts.push(JSON.parse(String(init?.body ?? '[]')) as Record<string, unknown>[]);
        return new Response('', { status: 201 });
      }
      return new Response(JSON.stringify(getRows), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    })
  );

  await db.settings.put({ key: 'deviceId', value: 'dev-test' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T14 schema_version 与未知 kind', () => {
  it('push 带 schema_version；未知 kind 不写业务表、不抛错并记录 id', async () => {
    await db.products.put(makeProduct('p1'));
    await enqueue('product', 'p1');
    getRows = [
      {
        id: 'mystery:1',
        record_id: '1',
        kind: 'mystery',
        data: { foo: 'bar' },
        updated_at: 1000,
        deleted: false,
        schema_version: 99
      }
    ];

    const result = await syncNow({
      url: 'https://example.supabase.co',
      anonKey: 'test-anon-key',
      ledgerKey: 'test-ledger'
    });

    expect(result.pushed).toBe(1);
    expect(result.pulled).toBe(1);
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toMatchObject({ schema_version: 2 });
    expect(typeof posts[0][0].record_updated_at).toBe('number');

    expect(await db.products.count()).toBe(1);
    expect(await db.orders.count()).toBe(0);
    expect(await db.sessions.count()).toBe(0);

    const raw = (await db.settings.get('sync-unknown-kinds'))?.value ?? '[]';
    expect(JSON.parse(raw)).toEqual(['mystery:1']);
    // 水位仍按 updated_at 推进，避免同一行反复拉取
    expect(store.get('yh-sync-last-pull')).toBe('1000');
  });

  it('已知 kind 正常写入；未知 kind 最多保留 20 条 id，且重复拉取不重复计入', async () => {
    getRows = [
      {
        id: 'order:o1',
        record_id: 'o1',
        kind: 'order',
        data: {
          id: 'o1',
          deviceId: 'other',
          operator: '对方',
          createdAt: '2026-11-01T10:00:00.000Z',
          payMethod: 'cash',
          totalFen: 2500,
          updatedAt: '2026-11-01T10:00:00.000Z'
        },
        updated_at: 2000,
        record_updated_at: Date.parse('2026-11-01T10:00:00.000Z'),
        deleted: false
      },
      ...Array.from({ length: 25 }, (_, i) => ({
        id: `mystery:${i + 1}`,
        record_id: String(i + 1),
        kind: 'mystery',
        data: {},
        updated_at: 2000,
        deleted: false
      }))
    ];

    await syncNow({
      url: 'https://example.supabase.co',
      anonKey: 'test-anon-key',
      ledgerKey: 'test-ledger'
    });

    // 已知 kind 必须落库（防止未知 kind 分支误伤正常记录）
    expect(await db.orders.count()).toBe(1);
    expect((await db.orders.get('o1'))?.totalFen).toBe(2500);

    let arr = JSON.parse((await db.settings.get('sync-unknown-kinds'))?.value ?? '[]') as string[];
    expect(arr).toHaveLength(20);
    expect(arr).toContain('mystery:25');
    expect(arr).not.toContain('mystery:1');

    // 模拟同一页被重复应用：id 去重，长度不增长
    await syncNow({
      url: 'https://example.supabase.co',
      anonKey: 'test-anon-key',
      ledgerKey: 'test-ledger'
    });
    arr = JSON.parse((await db.settings.get('sync-unknown-kinds'))?.value ?? '[]') as string[];
    expect(arr).toHaveLength(20);
    expect(await db.orders.count()).toBe(1);
  });
});