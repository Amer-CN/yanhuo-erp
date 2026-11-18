// B03：URL 真过滤的本机 fake fetch + fake-indexeddb，绝不访问真实 Supabase。
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDB, db, SCHEMA_VERSION } from '../src/db/db';
import { initialSyncPending, syncNow, type Kind } from '../src/db/sync';
import { localDate } from '../src/db/util';
import { makeLine, makeOrder, resetDb, T0 } from './helpers';

type CloudRow = {
  id: string;
  record_id: string;
  kind: Kind;
  data: Record<string, unknown>;
  updated_at: number;
  record_updated_at?: number;
  deleted: boolean;
  ledger: string;
};
const CFG = { url: 'http://127.0.0.1:54321', anonKey: 'fake-key', ledgerKey: 'b03-test-only' };
const BASE = 1_700_000_000_000;
const store = new Map<string, string>();
let cloud: CloudRow[];
let requests: URL[];
let lookups: URL[];
let lookupFailure: string | null;
let lookupMissingColumn: boolean;
let onLookup: (() => Promise<void>) | undefined;

function remote(kind: Kind, id: string, data: object, updated = BASE, deleted = false): CloudRow {
  return { id: `${kind}:${id}`, record_id: id, kind, data: { ...data }, updated_at: updated,
    record_updated_at: Date.parse(String((data as { updatedAt?: string }).updatedAt ?? T0)),
    deleted, ledger: CFG.ledgerKey };
}
const orderRow = (id: string, updated = BASE + 600_000) => remote('order', id, makeOrder(id, 500), updated);
const lineRow = (id: string, orderId: string, updated = BASE, overrides = {}): CloudRow & { kind: 'line' } =>
  ({ ...remote('line', id, makeLine(id, orderId, 'p1', 2, 500, overrides), updated), kind: 'line' });
function fillers(count: number, start = BASE + 1): CloudRow[] {
  return Array.from({ length: count }, (_, i) => remote('setting', `f${String(i).padStart(5, '0')}`,
    { key: `f${i}`, value: 'filler' }, start + i));
}
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

// PostgREST in 参数按独立字面值解析：引号里的逗号/括号不能变成过滤表达式。
function inValues(raw: string): string[] {
  if (!raw.startsWith('in.(') || !raw.endsWith(')')) throw new Error(`bad in filter: ${raw}`);
  const values: string[] = [];
  const text = raw.slice(4, -1);
  let token = '';
  let quoted = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) { token += ch; escaped = false; continue; }
    if (quoted && ch === '\\') { escaped = true; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { values.push(token); token = ''; continue; }
    if (!quoted && /[()]/.test(ch)) throw new Error('unquoted in value');
    token += ch;
  }
  if (quoted || escaped) throw new Error('unterminated in value');
  if (text) values.push(token);
  return values;
}

function filteredRows(url: URL, header: Headers): CloudRow[] {
  let rows = cloud.filter((row) => row.ledger === header.get('x-ledger-key'));
  for (const field of ['ledger', 'id', 'kind', 'record_id'] as const) {
    const value = url.searchParams.get(field);
    if (!value) continue;
    if (field === 'record_id' && value.startsWith('in.')) {
      const ids = inValues(value);
      rows = rows.filter((row) => ids.includes(row.record_id));
    } else {
      if (!value.startsWith('eq.')) throw new Error(`unsupported ${field} filter`);
      rows = rows.filter((row) => row[field] === value.slice(3));
    }
  }
  const timestamp = url.searchParams.get('updated_at');
  if (timestamp) {
    const match = /^(gte|gt)\.(\d+)$/.exec(timestamp);
    if (!match) throw new Error('bad timestamp filter');
    rows = rows.filter((row) => match[1] === 'gte' ? row.updated_at >= Number(match[2]) : row.updated_at > Number(match[2]));
  }
  const composite = url.searchParams.get('or');
  if (composite) {
    const match = /^\(updated_at\.gt\.(\d+),and\(updated_at\.eq\.(\d+),id\.gt\.(.*)\)\)$/.exec(composite);
    if (!match) throw new Error('bad composite filter');
    rows = rows.filter((row) => row.updated_at > Number(match[1]) ||
      (row.updated_at === Number(match[2]) && row.id > match[3]));
  }
  rows.sort((a, b) => a.updated_at - b.updated_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows.slice(0, Number(url.searchParams.get('limit') ?? 1000));
}

beforeEach(async () => {
  await db.open();
  await resetDb();
  store.clear();
  cloud = [];
  requests = [];
  lookups = [];
  lookupFailure = null;
  lookupMissingColumn = false;
  onLookup = undefined;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key)
  });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('/rpc/yh_sync_capabilities')) return Response.json({ code: 'PGRST202' }, { status: 404 });
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    expect(url.origin).toBe(CFG.url);
    expect(headers.get('x-ledger-key')).toBe(CFG.ledgerKey);
    if (init?.method === 'POST') return new Response(null, { status: 201 });
    requests.push(url);
    if (url.searchParams.get('kind') === 'eq.order') {
      lookups.push(url);
      await onLookup?.();
      if (lookupFailure) throw new Error(lookupFailure);
      if (lookupMissingColumn && url.searchParams.get('select')?.includes('record_updated_at')) {
        return new Response('42703: column record_updated_at does not exist', { status: 400 });
      }
    }
    return json(filteredRows(url, headers));
  }));
});

afterEach(async () => {
  await db.open();
  await resetDb();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('跨页父子与持久待决', () => {
  it('501 行：早 10 分钟的 line 在第一页，父单第二页；首轮与次轮明细均完整', async () => {
    cloud = [lineRow('early', 'later'), ...fillers(499), orderRow('later')];
    const first = await syncNow(CFG);
    expect(await db.orders.get('later')).toBeTruthy();
    expect(await db.lines.get('early')).toMatchObject({ orderId: 'later', amountFen: 500 });
    expect(first).toMatchObject({ deferredLines: 0, hasMore: false });
    expect(store.get('yh-sync-last-pull')).toBe(String(BASE + 600_000));
    const second = await syncNow(CFG);
    expect(await db.lines.where('orderId').equals('later').count()).toBe(1);
    expect(second).toMatchObject({ deferredLines: 0, hasMore: false });
    expect(await db.outbox.count()).toBe(0);
  });

  it('父未上传：line 不进入业务表，保留待决、推进已保存页游标并提示等待', async () => {
    cloud = [lineRow('waiting', 'not-uploaded')];
    const result = await syncNow(CFG);
    expect(await db.lines.get('waiting')).toBeUndefined();
    expect(await db.remotePendingLines.get('waiting')).toMatchObject({ orderId: 'not-uploaded', row: { record_id: 'waiting' } });
    expect(result).toMatchObject({ pulled: 0, deferredLines: 1, hasMore: true });
    expect(store.get('yh-sync-last-pull')).toBe(String(BASE));
    expect(store.get('yh-sync-warn')).toContain('明细等待主单同步');
    expect(store.get('yh-sync-warn')).not.toContain('父单已删除');
    expect(lookups).toHaveLength(1);
    expect(await db.outbox.count()).toBe(0);
  });

  it('DB 重启后父在下一天才到：从持久待决补齐，告警随条件消失', async () => {
    cloud = [lineRow('restart', 'tomorrow')];
    await syncNow(CFG);
    expect(await db.remotePendingLines.count()).toBe(1);
    db.close();
    await db.open();
    store.delete('yh-sync-last-replay');
    cloud.push(orderRow('tomorrow', BASE + 86_400_000));
    const result = await syncNow(CFG);
    expect(await db.lines.get('restart')).toMatchObject({ amountFen: 500 });
    expect(await db.remotePendingLines.count()).toBe(0);
    expect(result).toMatchObject({ deferredLines: 0, hasMore: false });
    expect(store.get('yh-sync-warn') ?? '').not.toContain('明细等待主单同步');
  });

  it('确认父墓碑才清待决，line 墓碑也清除其待决，不产生业务孤儿', async () => {
    cloud = [lineRow('gone', 'dead'), lineRow('own-delete', 'absent', BASE + 1)];
    await syncNow(CFG);
    expect(await db.remotePendingLines.count()).toBe(2);
    cloud = [remote('order', 'dead', {}, BASE + 600_000, true),
      { ...remote('line', 'own-delete', {}, BASE + 600_001, true), record_updated_at: 0 }];
    const result = await syncNow(CFG);
    expect(await db.remotePendingLines.count()).toBe(0);
    expect(await db.lines.count()).toBe(0);
    expect(result.deferredLines).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it('补查父墓碑时同页 line 不进入待决或业务表', async () => {
    store.set('yh-sync-last-pull', String(BASE + 1_000_000));
    store.set('yh-sync-last-replay', localDate());
    cloud = [remote('order', 'dead', {}, BASE, true), lineRow('never', 'dead', BASE + 1_000_001)];
    const result = await syncNow(CFG);
    expect(await db.lines.count()).toBe(0);
    expect(await db.remotePendingLines.count()).toBe(0);
    expect(result).toMatchObject({ deferredLines: 0, hasMore: false });
    expect(lookups).toHaveLength(1);
  });

  it('父本地 pending delete：补查不得复活父或吞队列；删除完成前 line 留待决', async () => {
    cloud = [lineRow('local-delete-child', 'deleting'), ...fillers(499), orderRow('deleting')];
    onLookup = async () => {
      await db.outbox.put({ id: 'order:deleting', kind: 'order', recordId: 'deleting', op: 'delete', queuedAt: Date.now(), revision: 'local-delete' });
    };
    const result = await syncNow(CFG);
    expect(lookups.length).toBeGreaterThan(0);
    expect(await db.orders.get('deleting')).toBeUndefined();
    expect(await db.lines.get('local-delete-child')).toBeUndefined();
    expect(await db.remotePendingLines.get('local-delete-child')).toBeTruthy();
    expect(await db.outbox.get('order:deleting')).toMatchObject({ op: 'delete', revision: 'local-delete' });
    expect(result).toMatchObject({ deferredLines: 1, hasMore: true });
    onLookup = undefined;
    cloud = [remote('order', 'deleting', {}, BASE + 900_000, true)];
    await syncNow(CFG);
    expect(await db.remotePendingLines.count()).toBe(0);
  });

  it('同 id 较旧待决不能覆盖新已落地 line，重复页不会留旧待决', async () => {
    cloud = [lineRow('versioned', 'old-parent')];
    await syncNow(CFG);
    cloud = [lineRow('versioned', 'new-parent', BASE + 600_001, { amountFen: 900, updatedAt: '2026-11-03T10:00:00Z' }),
      orderRow('new-parent', BASE + 600_000), orderRow('old-parent', BASE + 1_200_000)];
    await syncNow(CFG);
    expect(await db.lines.get('versioned')).toMatchObject({ orderId: 'new-parent', amountFen: 900 });
    expect(await db.remotePendingLines.get('versioned')).toBeUndefined();
    cloud.push(lineRow('versioned', 'old-parent', BASE + 1_200_001));
    await syncNow(CFG);
    expect(await db.lines.get('versioned')).toMatchObject({ orderId: 'new-parent', amountFen: 900 });
  });
});

describe('父单补查的配额、过滤与失败', () => {
  it('每轮最多 100 个不同父 id，50 个一批；次轮可继续补齐前轮剩余', async () => {
    cloud = Array.from({ length: 101 }, (_, i) => lineRow(`q${i}`, `missing${i}`, BASE + i));
    const first = await syncNow(CFG);
    expect(lookups).toHaveLength(2);
    const ids = lookups.flatMap((url) => inValues(url.searchParams.get('record_id')!));
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
    expect(lookups.map((url) => inValues(url.searchParams.get('record_id')!).length)).toEqual([50, 50]);
    expect(first).toMatchObject({ deferredLines: 101, hasMore: true });
    expect(await db.remotePendingLines.count()).toBe(101);
    cloud = [orderRow('missing100', BASE - 1_000_000)];
    lookups = [];
    await syncNow(CFG);
    expect(await db.lines.get('q100')).toBeTruthy();
    expect(await db.remotePendingLines.count()).toBe(100);
  });

  it('未知格式父 id 作为单个 in 字面值编码，不注入额外过滤或读到其他账本', async () => {
    const parentId = 'odd,paren).quote"slash\\&kind=eq.product';
    cloud = [lineRow('odd-child', parentId), ...fillers(499), orderRow(parentId),
      { ...orderRow('foreign'), ledger: 'other-ledger' }];
    const result = await syncNow(CFG);
    expect(await db.lines.get('odd-child')).toMatchObject({ orderId: parentId });
    expect(await db.orders.get('foreign')).toBeUndefined();
    expect(inValues(lookups[0].searchParams.get('record_id')!)).toEqual([parentId]);
    expect(lookups[0].searchParams.get('kind')).toBe('eq.order');
    expect(result.deferredLines).toBe(0);
  });

  it('补查继承缺列降级，同一配置 ledger 头不变，父及 line 正常落库', async () => {
    store.set('yh-sync-last-pull', String(BASE + 1_000_000));
    store.set('yh-sync-last-replay', localDate());
    cloud = [orderRow('legacy-parent', BASE), lineRow('legacy-child', 'legacy-parent', BASE + 1_000_001)];
    lookupMissingColumn = true;
    await syncNow(CFG);
    expect(lookups).toHaveLength(2);
    expect(lookups[0].searchParams.get('select')).toContain('record_updated_at');
    expect(lookups[1].searchParams.get('select')).not.toContain('record_updated_at');
    expect(await db.lines.get('legacy-child')).toBeTruthy();
    expect(store.get('yh-sync-warn')).toContain('降级');
  });

  it('补查网络失败不吞错、不落该页业务与待决、不推进 cursor，重试可恢复', async () => {
    cloud = [lineRow('retry', 'parent'), ...fillers(499), orderRow('parent')];
    lookupFailure = 'parent lookup unavailable';
    await expect(syncNow(CFG)).rejects.toThrow('parent lookup unavailable');
    expect(store.get('yh-sync-last-pull')).toBeUndefined();
    expect(await db.lines.count()).toBe(0);
    expect(await db.remotePendingLines.count()).toBe(0);
    lookupFailure = null;
    await syncNow(CFG);
    expect(await db.lines.get('retry')).toBeTruthy();
  });

  it('待决达到 10000 上限仍可更新同 id；新增超限回滚整页且不推进游标', async () => {
    await db.remotePendingLines.bulkPut(Array.from({ length: 10_000 }, (_, i) => ({
      id: `full${i}`, orderId: 'missing', row: lineRow(`full${i}`, 'missing'), receivedAt: BASE
    })));
    cloud = [remote('setting', 'atomic', { key: 'atomic', value: 'rollback' }, BASE - 1), lineRow('overflow', 'missing')];
    await expect(syncNow(CFG)).rejects.toThrow(/10000|待决.*上限/);
    expect(await db.settings.get('atomic')).toBeUndefined();
    expect(await db.remotePendingLines.count()).toBe(10_000);
    expect(store.get('yh-sync-last-pull')).toBeUndefined();
    cloud = [lineRow('full0', 'missing', BASE + 1, { amountFen: 600, updatedAt: '2026-11-04T10:00:00Z' })];
    await syncNow(CFG);
    expect(await db.remotePendingLines.count()).toBe(10_000);
    expect((await db.remotePendingLines.get('full0'))?.row.data.amountFen).toBe(600);
  }, 20_000);

  it('待决写入异常导致同页业务回滚，cursor 保持；下次重放成功', async () => {
    cloud = [remote('setting', 'atomic', { key: 'atomic', value: 'value' }, BASE - 1), lineRow('failed-write', 'missing')];
    const hook = () => { throw new Error('pending storage failed'); };
    db.remotePendingLines.hook('creating', hook);
    try {
      await expect(syncNow(CFG)).rejects.toThrow('pending storage failed');
      expect(await db.settings.get('atomic')).toBeUndefined();
      expect(store.get('yh-sync-last-pull')).toBeUndefined();
    } finally {
      db.remotePendingLines.hook('creating').unsubscribe(hook);
    }
    const result = await syncNow(CFG);
    expect(await db.remotePendingLines.get('failed-write')).toBeTruthy();
    expect(result.deferredLines).toBe(1);
  });
});

describe('首次下载状态', () => {
  it('已经成功过但首次下载仍 pending 时，hook 重挂载仍为未完成', async () => {
    store.set('yh-sync-last-sync', String(BASE));
    store.set('yh-sync-initial-pending', '1');
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { useSync } = await import('../src/ui/useSync');
    function Probe() {
      const state = useSync();
      return createElement('span', null, state.initialSync);
    }
    expect(renderToStaticMarkup(createElement(Probe))).toContain('idle');
  });
  it('更多页等待主单时显示未完成，不能把待决状态显示成已连接', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { default: MorePage } = await import('../src/ui/MorePage');
    const html = renderToStaticMarkup(createElement(MorePage, {
      products: 0, orders: 0, summary: { revenueFen: 0, orderCount: 0 }, deviceName: 'test',
      sync: { configured: true, online: true, syncing: false, pending: 0, error: null,
        initialSync: 'idle', pulledCount: 20, hasMore: true, deferredLines: 2 },
      onOpen: () => undefined, onCloseSession: () => undefined
    }));
    expect(html).toContain('明细等待主单同步');
    expect(html).not.toContain('已连接');
  });
});

describe('大账本续扫与迁移', () => {
  it('10001 行时间集中在 5 分钟内：capped 后 replay 续扫不再 overlap，最终明细齐全', async () => {
    cloud = [lineRow('first-page', 'last-parent'), ...fillers(9999), orderRow('last-parent', BASE + 20_000)];
    const first = await syncNow(CFG);
    expect(first.hasMore).toBe(true);
    expect(initialSyncPending()).toBe(true);
    expect(store.get('yh-sync-initial-pending')).toBe('1');
    expect(store.get('yh-sync-last-replay')).toBeUndefined();
    const resume = JSON.parse(store.get('yh-sync-last-replay-cursor')!);
    const before = requests.length;
    const second = await syncNow(CFG);
    expect(await db.lines.get('first-page')).toBeTruthy();
    expect(second).toMatchObject({ hasMore: false, deferredLines: 0 });
    expect(initialSyncPending()).toBe(false);
    expect(store.get('yh-sync-initial-pending')).toBeUndefined();
    expect(store.get('yh-sync-last-replay')).toBeTruthy();
    expect(store.get('yh-sync-last-replay-cursor')).toBeUndefined();
    expect(requests.slice(before).some((url) => url.searchParams.get('or') ===
      `(updated_at.gt.${resume.ts},and(updated_at.eq.${resume.ts},id.gt.${resume.id}))`)).toBe(true);
  }, 20_000);

  it('v4 经 v5 conflict 去重再到 v6，保留业务与最新冲突，v6 重开不丢待决', async () => {
    db.close();
    await db.delete();
    const old = new Dexie('yanhuo-erp');
    old.version(4).stores({
      products: 'id, category, name, archived, sortOrder', batches: 'id, productId, receivedAt, expiryDate',
      orders: 'id, createdAt, deviceId, payMethod, voided, sessionId', lines: 'id, orderId, productId',
      adjustments: 'id, productId, createdAt', settings: 'key', outbox: 'id, queuedAt',
      sessions: 'id, status, startedAt, closedAt, deviceId', conflicts: '++id, at, kind, recordId'
    });
    await old.table('orders').put(makeOrder('preserved', 500));
    await old.table('conflicts').bulkAdd([
      { kind: 'order', recordId: 'same', at: '2026-11-01', local: 'old', remote: 'old' },
      { kind: 'order', recordId: 'same', at: '2026-11-02', local: 'new', remote: 'new' }
    ]);
    old.close();
    const upgraded = new AppDB();
    try {
      await upgraded.open();
      expect(SCHEMA_VERSION).toBe(8);
      expect(upgraded.verno).toBe(8);
      expect(await upgraded.orders.get('preserved')).toBeTruthy();
      expect(await upgraded.conflicts.count()).toBe(1);
      expect((await upgraded.conflicts.toArray())[0].local).toBe('new');
      await upgraded.remotePendingLines.put({ id: 'saved', orderId: 'missing', row: lineRow('saved', 'missing'), receivedAt: BASE });
      upgraded.close();
      await upgraded.open();
      expect(await upgraded.remotePendingLines.get('saved')).toBeTruthy();
    } finally {
      upgraded.close();
      await db.open();
    }
  });
});
