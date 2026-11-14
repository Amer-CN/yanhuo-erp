import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { db } from '../src/db/db';
import { SyncCoordinator, __setSyncControlForTest, pauseSync, readSyncControl } from '../src/db/syncControl';
import { protocolScope } from '../src/db/syncProtocol';
import type { SyncConfig } from '../src/db/syncTypes';
import { makeOrder, makeProduct, makeLine, resetDb, T0 } from './helpers';
import { confirmReconnect, prepareReconnect } from '../src/db/syncReconnect';

const CFG: SyncConfig = { url: 'http://127.0.0.1:54321', anonKey: 'test-key', ledgerKey: 'ledger-a' };
const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const V2 = {
  protocolVersion: 2, conflictTarget: 'ledger,id', ledgerScoped: true, clearRpcEnabled: true,
  clearEpoch: 0, epochHeader: 'x-yh-clear-epoch', epochHeaderRequired: false
};

type CloudRow = {
  id: string; record_id: string; kind: string; data: Record<string, unknown>;
  updated_at: number; record_updated_at: number; deleted: boolean;
};
let cloud: CloudRow[];
let fetchMock: ReturnType<typeof vi.fn>;
let calls: URL[];
let dbName: string;
let store: Map<string, string>;

function remote(kind: string, id: string, data: Record<string, unknown>, updatedAt = NOW, deleted = false): CloudRow {
  return { id: `${kind}:${id}`, record_id: id, kind, data, updated_at: updatedAt,
    record_updated_at: Date.parse(String(data.updatedAt ?? data.createdAt ?? T0)), deleted };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function product(id: string, priceList: number, updatedAt = T0) {
  return { ...makeProduct(id, { priceList, updatedAt }), sample: undefined };
}

function localProduct(id: string, priceList: number, updatedAt = T0) {
  return makeProduct(id, { priceList, updatedAt });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await db.open();
  await resetDb();
  await db.syncMeta.clear();
  __setSyncControlForTest(new SyncCoordinator(db, db.syncMeta));
  dbName = db.name;
  cloud = [];
  calls = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname !== '127.0.0.1') throw new Error(`non-loopback fetch blocked: ${url.hostname}`);
    if (url.pathname.endsWith('/rpc/yh_sync_capabilities')) return json(V2);
    if (url.pathname.endsWith('/yh_records') && (!init?.method || init.method === 'GET')) {
      const ledger = url.searchParams.get('ledger');
      expect(ledger).toBe('eq.ledger-a');
      const ordered = cloud.filter((row) => !row.id.startsWith('__ledger_cleared__:'))
        .filter((row) => url.searchParams.get('kind') === null || `eq.${row.kind}` === url.searchParams.get('kind'))
        .filter((row) => {
          const or = url.searchParams.get('or');
          if (!or) return true;
          const match = or.match(/updated_at\.gt\.(\d+),and\(updated_at\.eq\.(\d+),id\.gt\.(.*)\)/);
          if (!match) throw new Error(`unhandled cursor ${or}`);
          const [, ts, sameTs, id] = match;
          return row.updated_at > Number(ts) || (row.updated_at === Number(sameTs) && row.id > id);
        })
        .sort((a, b) => a.updated_at - b.updated_at || a.id.localeCompare(b.id));
      return json(ordered.slice(0, Number(url.searchParams.get('limit') ?? 500)));
    }
    throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  // Maintenance's interval is never awaited in these short callback tests.
  vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 1 as unknown as ReturnType<typeof setInterval>);
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
  store = new Map([['yh-sync-disabled', '1']]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key), clear: () => store.clear()
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  __setSyncControlForTest(undefined);
  await resetDb();
  await db.syncMeta.clear();
  db.close();
  await Dexie.delete(dbName);
});

describe('sync reconnect', () => {
  it('copies confirmed choices before network work so caller mutation cannot skip a conflict', async () => {
    await db.products.put(localProduct('p1', 100));
    cloud = [remote('product', 'p1', product('p1', 200))];
    const preview = await prepareReconnect(CFG);
    const choices: Record<string, 'local' | 'remote'> = { 'product:p1': 'remote' };
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      delete choices['product:p1'];
      return original(input, init);
    });
    await confirmReconnect(preview, choices);
    expect(await db.products.get('p1')).toMatchObject({ priceList: 200 });
  });

  it('isolates two selected ledger scopes and invalidates the earlier preview', async () => {
    const other = { ...CFG, ledgerKey: 'ledger-b' };
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe('127.0.0.1');
      if (url.pathname.includes('/rpc/')) return json(V2);
      expect(init?.method).toBe('GET');
      const id = url.searchParams.get('ledger') === 'eq.ledger-b' ? 'only-b' : 'only-a';
      return json([remote('product', id, product(id, 100))]);
    });
    const a = await prepareReconnect(CFG);
    const b = await prepareReconnect(other);
    await expect(confirmReconnect(a, {})).rejects.toThrow(/stale/i);
    await confirmReconnect(b, {});
    expect(await db.products.get('only-b')).toBeTruthy();
    expect(await db.products.get('only-a')).toBeUndefined();
    expect(store.get('yh-sync-ledger')).toBe('ledger-b');
  });

  it('supports the explicit missing-capability legacy protocol without posting business rows', async () => {
    store.set('yh-sync-url', CFG.url); store.set('yh-sync-anon', CFG.anonKey); store.set('yh-sync-ledger', CFG.ledgerKey);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('/rpc/') ? json({ code: 'PGRST202' }, 404) : original(input, init));
    cloud = [remote('product', 'remote', product('remote', 200))];
    const preview = await prepareReconnect(CFG);
    await confirmReconnect(preview, {});
    expect(await db.products.get('remote')).toMatchObject({ priceList: 200 });
    expect(await db.outbox.count()).toBe(0);
  });

  it('invalidates the old memory token when a later preview is prepared, and never stores credentials or snapshots', async () => {
    cloud = [remote('product', 'p1', product('p1', 100))];
    const older = await prepareReconnect(CFG);
    const newer = await prepareReconnect({ ...CFG, anonKey: 'new-key' });
    await expect(confirmReconnect(older, {})).rejects.toThrow(/stale/i);
    const persisted = JSON.stringify(await db.syncMeta.toArray());
    expect(persisted).not.toContain(CFG.anonKey);
    expect(persisted).not.toContain('new-key');
    expect(persisted).not.toContain('priceList');
    await expect(confirmReconnect(newer, {})).resolves.toMatchObject({ generation: newer.generation + 1 });
  });

  it('rejects a changed clear marker even when every business row is unchanged', async () => {
    cloud = [remote('product', 'p1', product('p1', 100))];
    const original = fetchMock.getMockImplementation()!;
    let clearedAt = NOW;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(input, init);
      if (!String(input).includes('/yh_records')) return response;
      const rows = await response.json() as CloudRow[];
      return json([...rows, { id: `__ledger_cleared__:${CFG.ledgerKey}`, kind: 'ledger',
        record_id: CFG.ledgerKey, updated_at: clearedAt, deleted: false, data: { clearedAt } }]
        .sort((a, b) => a.updated_at - b.updated_at || a.id.localeCompare(b.id)));
    });
    const preview = await prepareReconnect(CFG);
    clearedAt++;
    await expect(confirmReconnect(preview, {})).rejects.toThrow(/changed|stale/i);
    expect(await readSyncControl()).toMatchObject({ paused: true });
  });

  it.each(['offline', 'invalid-page', 'invalid-record'] as const)('fails closed for %s and preserves the persistent pause', async (mode) => {
    if (mode === 'invalid-record') cloud = [remote('product', 'bad', { name: 'bad' })];
    if (mode === 'offline') fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    if (mode === 'invalid-page') fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).includes('/rpc/') ? json(V2) : json({ rows: [] }));
    await expect(prepareReconnect(CFG)).rejects.toThrow();
    expect(await db.products.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect(await readSyncControl()).toMatchObject({ paused: true });
  });

  it('preserves the pause when config storage fails after the atomic database commit', async () => {
    await db.products.put(localProduct('local', 100));
    const preview = await prepareReconnect(CFG);
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
    await expect(confirmReconnect(preview, {})).rejects.toThrow('storage blocked');
    expect(await readSyncControl()).toMatchObject({ paused: true, generation: preview.generation + 1 });
    expect(await db.outbox.get('product:local')).toMatchObject({ op: 'upsert', revision: expect.any(String) });
    expect(store.get('yh-sync-disabled')).toBe('1');
  });

  it('rejects changed generation and modified preview scope before applying anything', async () => {
    const preview = await prepareReconnect(CFG);
    await expect(confirmReconnect({ ...preview, scope: protocolScope({ ...CFG, ledgerKey: 'ledger-b' }) }, {}))
      .rejects.toThrow(/stale|token/i);
    await pauseSync('another maintenance decision');
    await expect(confirmReconnect(preview, {})).rejects.toThrow(/generation|stale/i);
    expect(await readSyncControl()).toMatchObject({ paused: true });
  });

  it.each(['missing-header', 'incomplete-lines', 'shared-line'] as const)('rejects unsafe order grouping: %s', async (mode) => {
    const line = { ...makeLine('line', 'o1', 'p1', 1, 100) };
    cloud = [remote('line', 'line', line)];
    if (mode === 'incomplete-lines') cloud.push(remote('order', 'o1', {
      ...makeOrder('o1', 100, 's1', { lineIds: ['line', 'missing'] })
    }));
    if (mode === 'shared-line') {
      await db.orders.put(makeOrder('o2', 100, 's1', { lineIds: ['line'] }));
      await db.lines.put(makeLine('line', 'o2', 'p1', 1, 100));
      cloud.push(remote('order', 'o1', { ...makeOrder('o1', 100, 's1', { lineIds: ['line'] }) }));
    }
    await expect(prepareReconnect(CFG)).rejects.toThrow(/header|incomplete|shared/i);
    expect(await db.outbox.count()).toBe(0);
  });

  it('ignores device settings while retaining legacy complete order groups', async () => {
    await db.settings.put({ key: 'deviceId', value: 'local-device' });
    cloud = [remote('setting', 'deviceId', { key: 'deviceId', value: 'remote-device' }),
      remote('order', 'legacy', { ...makeOrder('legacy', 100) }),
      remote('line', 'legacy-line', { ...makeLine('legacy-line', 'legacy', 'p1', 1, 100) })];
    const preview = await prepareReconnect(CFG);
    expect(preview.counts).toMatchObject({ remoteOnly: 1, different: 0 });
    await confirmReconnect(preview, {});
    expect(await db.settings.get('deviceId')).toEqual({ key: 'deviceId', value: 'local-device' });
    expect(await db.orders.get('legacy')).toMatchObject({ totalFen: 100 });
    expect(await db.outbox.count()).toBe(0);
  });

  it('previews a paginated ledger snapshot without applying or queuing records', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => {
      const id = `remote-${String(i).padStart(3, '0')}`;
      return remote('product', id, product(id, i + 1), NOW + i);
    });
    cloud = rows;
    const preview = await prepareReconnect(CFG);
    expect(preview.counts).toMatchObject({ localOnly: 0, remoteOnly: 501, different: 0, same: 0 });
    expect(preview.groups).toHaveLength(501);
    expect(calls.filter((url) => url.pathname.endsWith('/yh_records'))).toHaveLength(2);
    expect((await db.products.toArray())).toEqual([]);
    expect(await db.outbox.count()).toBe(0);
    expect(await readSyncControl()).toMatchObject({ paused: true, reason: expect.any(String) });
  });

  it('keeps remote-only rows, uploads local-only with a fresh business time, and never queues same rows', async () => {
    await db.products.bulkPut([
      localProduct('local', 100, T0), localProduct('same', 300, T0)
    ]);
    cloud = [
      remote('product', 'remote', product('remote', 200, '2099-01-01T00:00:00.000Z'), Date.parse('2099-01-01')),
      remote('product', 'same', product('same', 300, T0))
    ];
    const preview = await prepareReconnect(CFG);
    expect(preview.counts).toEqual({ localOnly: 1, remoteOnly: 1, different: 0, same: 1 });
    const result = await confirmReconnect(preview, {});
    expect(result.generation).toBe(preview.generation + 1);
    expect(await db.products.get('remote')).toMatchObject({ priceList: 200 });
    expect(await db.products.get('local')).toMatchObject({ updatedAt: '2099-01-01T00:00:00.001Z' });
    expect(await db.outbox.toArray()).toMatchObject([{ id: 'product:local', op: 'upsert' }]);
    expect(await db.outbox.get('product:same')).toBeUndefined();
    expect(calls.some((url) => url.pathname.endsWith('/yh_records') && url.searchParams.has('on_conflict'))).toBe(false);
    expect(await readSyncControl()).toMatchObject({ paused: false, generation: preview.generation + 1 });
    expect(store.get('yh-sync-url')).toBe(CFG.url);
    expect(store.get('yh-sync-anon')).toBe(CFG.anonKey);
    expect(store.get('yh-sync-ledger')).toBe(CFG.ledgerKey);
    expect(store.has('yh-sync-disabled')).toBe(false);
  });

  it('requires an explicit choice for local-live versus remote tombstone and never pushes a delete', async () => {
    await db.products.put(localProduct('p1', 100));
    cloud = [remote('product', 'p1', {}, NOW + 1, true)];
    const preview = await prepareReconnect(CFG);
    expect(preview.groups).toContainEqual(expect.objectContaining({ recordKey: 'product:p1', status: 'different' }));
    await expect(confirmReconnect(preview, {})).rejects.toThrow(/choice/i);
    await expect(confirmReconnect(preview, { 'product:p1': 'remote' })).resolves.toEqual({ generation: preview.generation + 1 });
    expect(await db.products.get('p1')).toBeUndefined();
    expect(await db.outbox.get('product:p1')).toBeUndefined();
  });

  it('groups each order with its complete lines and applies a selected local version together', async () => {
    const localOrder = makeOrder('o1', 100, 's1', { lineIds: ['l1'] });
    const localLine = makeLine('l1', 'o1', 'p1', 1, 100);
    await db.orders.put(localOrder);
    await db.lines.put(localLine);
    const remoteOrder = { ...makeOrder('o1', 200, 's1', { deviceId: 'other', lineIds: ['l2'] }) };
    const remoteLine = { ...makeLine('l2', 'o1', 'p2', 1, 200) };
    cloud = [remote('order', 'o1', remoteOrder), remote('line', 'l2', remoteLine)];
    const preview = await prepareReconnect(CFG);
    expect(preview.groups.filter((group) => group.recordKey === 'order:o1')).toHaveLength(1);
    expect(preview.groups.find((group) => group.recordKey === 'order:o1')).toMatchObject({
      status: 'different', localCount: 2, remoteCount: 2,
      label: expect.stringContaining('订单'), localText: expect.stringContaining('1.00'), remoteText: expect.stringContaining('2.00')
    });
    await confirmReconnect(preview, { 'order:o1': 'local' });
    expect(await db.orders.get('o1')).toMatchObject({ totalFen: 100, lineIds: ['l1'] });
    expect(await db.lines.get('l1')).toMatchObject({ orderId: 'o1' });
    expect(await db.lines.get('l2')).toBeUndefined();
    expect(await db.outbox.get('order:o1')).toMatchObject({ op: 'upsert' });
    expect(await db.outbox.get('line:l1')).toMatchObject({ op: 'upsert' });
    expect(await db.outbox.get('line:l2')).toMatchObject({ op: 'delete', scope: protocolScope(CFG), clearEpoch: 0 });
  });

  it.each(['local', 'remote'] as const)('rejects a stale %s snapshot and keeps the ledger paused', async (changed) => {
    await db.products.put(localProduct('p1', 100));
    cloud = [remote('product', 'p2', product('p2', 200))];
    const preview = await prepareReconnect(CFG);
    if (changed === 'local') await db.products.put(localProduct('p1', 101));
    else cloud = [...cloud, remote('product', 'p3', product('p3', 300), NOW + 1)];
    await expect(confirmReconnect(preview, {})).rejects.toThrow(/changed|stale|snapshot/i);
    expect(await readSyncControl()).toMatchObject({ paused: true });
    expect(await db.outbox.count()).toBe(0);
  });

  it('retains the persistent pause across coordinator reconstruction and clears only the matching scope marker on success', async () => {
    cloud = [remote('product', 'remote', product('remote', 200))];
    const preview = await prepareReconnect(CFG);
    const paused = await readSyncControl();
    db.close();
    await db.open();
    __setSyncControlForTest(new SyncCoordinator(db, db.syncMeta));
    expect(await readSyncControl()).toEqual(paused);
    await confirmReconnect(preview, {});
    const rows = await db.syncMeta.toArray() as unknown as { key: string; kind?: string; scope?: string }[];
    expect(rows.some((row) => row.kind === 'reconnect-recovery')).toBe(false);
    // Only remote rows were adopted; no upload means no conditional-write baseline is needed.
    expect(rows.some((row) => row.kind === 'reconnect-baseline' && row.scope === protocolScope(CFG))).toBe(false);
    expect(rows.some((row) => row.key.includes('ledger-b'))).toBe(false);
  });

  it('rolls back updated timestamps, queue, baseline, and recovery clearing when outbox fails', async () => {
    await db.products.put(localProduct('local', 100));
    cloud = [];
    const preview = await prepareReconnect(CFG);
    const fail = () => { throw new Error('outbox unavailable'); };
    db.outbox.hook('creating', fail);
    try {
      await expect(confirmReconnect(preview, {})).rejects.toThrow('outbox unavailable');
    } finally {
      db.outbox.hook('creating').unsubscribe(fail);
    }
    expect(await db.products.get('local')).toMatchObject({ updatedAt: T0 });
    expect(await db.outbox.count()).toBe(0);
    expect(await readSyncControl()).toMatchObject({ paused: true });
    const meta = await db.syncMeta.toArray() as unknown as { kind?: string }[];
    expect(meta.some((row) => row.kind === 'reconnect-recovery')).toBe(true);
    expect(meta.some((row) => row.kind === 'reconnect-baseline')).toBe(false);
  });

  it('keeps equal raw ids in different kinds and scopes requests to the selected ledger', async () => {
    await db.products.put(localProduct('shared', 100));
    cloud = [remote('batch', 'shared', {
      id: 'shared', productId: 'shared', qtyBase: 1, unitCostFen: 1, receivedAt: '2026-11-14',
      deviceId: 'other', createdAt: T0
    })];
    const preview = await prepareReconnect(CFG);
    expect(preview.groups.map((group) => group.recordKey)).toContain('batch:shared');
    expect(preview.groups.map((group) => group.recordKey)).toContain('product:shared');
    expect(calls.every((url) => url.hostname === '127.0.0.1')).toBe(true);
    expect(calls.filter((url) => url.pathname.endsWith('/yh_records')).every((url) =>
      url.searchParams.get('ledger') === 'eq.ledger-a')).toBe(true);
  });
});
