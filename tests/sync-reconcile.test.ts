import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, type OutboxRow } from '../src/db/db';
import { canonicalJson } from '../src/db/canonical';
import { enqueueInTx } from '../src/db/outbox';
import { __resetSyncFlagsForTest, adoptRemoteConflict, clearSyncConfig, dropLocalRecord, restoreLocalSnapshot, syncNow } from '../src/db/sync';
import { SyncCoordinator, __setSyncControlForTest, pauseSync, readSyncControl, resumeSync, runMaintenance } from '../src/db/syncControl';
import { protocolScope } from '../src/db/syncProtocol';
import { confirmReconnect, prepareReconnect } from '../src/db/syncReconnect';
import { makeLine, makeOrder, makeProduct, resetDb, T0 } from './helpers';
import sqlFixture from '../supabase/tests/reconcile.fixture.json';

const CFG = { url: 'http://127.0.0.1:54321', anonKey: 'test-key', ledgerKey: 'reconcile-test' };
const SCOPE = protocolScope(CFG);
const BASELINE_KEY = `reconnect-baseline:${SCOPE}`;
const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const V2 = { protocolVersion: 2, conflictTarget: 'ledger,id', ledgerScoped: true, clearRpcEnabled: true,
  clearEpoch: 0, epochHeader: 'x-yh-clear-epoch', epochHeaderRequired: false };
type CloudRow = { id: string; record_id: string; kind: string; data: Record<string, unknown>;
  updated_at: number; record_updated_at: number; deleted: boolean; ledger?: string;
  clear_epoch?: number; schema_version?: number; device_id?: string };
type Payload = { p_operation_id: string; p_expected: CloudRow[]; p_rows: CloudRow[] };
type Baseline = { key: string; kind: string; scope: string; generation: number; operationId: string;
  expectedRows: CloudRow[]; sentPayload?: CloudRow[]; sentRows?: OutboxRow[] };
const meta = db.table<Baseline, string>('syncMeta');
let cloud: CloudRow[];
let calls: { url: URL; init?: RequestInit }[];
let rpcBodies: Payload[];
let receipts: Map<string, { operationId: string; pushedCount: number }>;
let store: Map<string, string>;
let legacy: boolean;
let rpcStatus: number | undefined;
let loseResponse: boolean;
let beforeRpc: (() => Promise<void>) | undefined;
let afterCommit: (() => Promise<void>) | undefined;
let release: (() => void) | undefined;
let running: Promise<unknown> | undefined;

function remote(kind: string, id: string, data: Record<string, unknown>, time = NOW, deleted = false): CloudRow {
  return { id: `${kind}:${id}`, record_id: id, kind, data, updated_at: time,
    record_updated_at: Date.parse(String(data.updatedAt ?? data.createdAt ?? T0)), deleted };
}
function projection(rows: CloudRow[]): CloudRow[] {
  return rows.filter(row => !(row.kind === 'setting' &&
    ['deviceId', 'deviceName', 'operatorSelf', 'sync-unknown-kinds'].includes(row.record_id)))
    .map(({ id, record_id, kind, data, updated_at, record_updated_at, deleted }) =>
      ({ id, record_id, kind, data, updated_at, record_updated_at, deleted }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function putLocal(price = 100) { await db.products.put(makeProduct('p1', { priceList: price })); }
async function confirmLocal() {
  await putLocal();
  cloud = [remote('product', 'p1', { ...makeProduct('p1', { priceList: 200 }) })];
  const preview = await prepareReconnect(CFG);
  await confirmReconnect(preview, { 'product:p1': 'local' });
  return preview;
}
async function editLocal(price: number) {
  await db.transaction('rw', [db.products, db.outbox, db.syncMeta], async () => {
    await db.products.update('p1', { priceList: price, updatedAt: new Date(NOW + 100).toISOString() });
    await enqueueInTx([{ kind: 'product', recordId: 'p1' }]);
  });
}
function startSync() {
  running = syncNow(CFG); void running.catch(() => {}); return running;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  await db.open(); await resetDb();
  __setSyncControlForTest(new SyncCoordinator(db, db.syncMeta)); __resetSyncFlagsForTest();
  cloud = []; calls = []; rpcBodies = []; receipts = new Map(); legacy = false;
  rpcStatus = undefined; loseResponse = false; beforeRpc = undefined; afterCommit = undefined;
  release = undefined; running = undefined;
  store = new Map([['yh-sync-disabled', '1']]);
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)), removeItem: (key: string) => store.delete(key) });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== CFG.url) throw new Error(`non-loopback fetch blocked: ${url.origin}`);
    calls.push({ url, init });
    expect(Dexie.currentTransaction).toBeFalsy();
    if (url.pathname.endsWith('/rpc/yh_sync_capabilities'))
      return legacy ? Response.json({ code: 'PGRST202' }, { status: 404 }) : Response.json(V2);
    if (url.pathname.endsWith('/rpc/yh_reconcile_push')) {
      const body = JSON.parse(String(init?.body)) as Payload; rpcBodies.push(body);
      // The exact first request and queue versions must be durable BEFORE transport starts.
      expect(await meta.get(BASELINE_KEY)).toMatchObject({ operationId: body.p_operation_id,
        expectedRows: body.p_expected, sentPayload: body.p_rows, sentRows: expect.any(Array) });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('x-ledger-key')).toBe(CFG.ledgerKey);
      expect(new Headers(init?.headers).get('x-yh-clear-epoch')).toBe('0');
      await beforeRpc?.();
      if (rpcStatus) return Response.json({ code: 'PGRST202' }, { status: rpcStatus });
      const receipt = receipts.get(body.p_operation_id);
      if (receipt) return Response.json(receipt);
      if (canonicalJson(body.p_expected) !== canonicalJson(projection(cloud)))
        return Response.json({ message: 'SYNC_RECONNECT_BASELINE_CHANGED' }, { status: 400 });
      for (const row of body.p_rows) {
        const index = cloud.findIndex(existing => existing.id === row.id);
        if (index < 0) cloud.push(row); else cloud[index] = row;
      }
      const result = { operationId: body.p_operation_id, pushedCount: body.p_rows.length };
      receipts.set(body.p_operation_id, result);
      await afterCommit?.();
      if (loseResponse) { loseResponse = false; throw new TypeError('response lost after commit'); }
      return Response.json(result);
    }
    if (!url.pathname.endsWith('/yh_records')) throw new Error(`unexpected request: ${url}`);
    if (init?.method === 'POST') return new Response(null, { status: 201 });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(url.searchParams.get('ledger')).toBe(`eq.${CFG.ledgerKey}`);
    let rows = cloud;
    const id = url.searchParams.get('id');
    if (id?.startsWith('eq.')) rows = rows.filter(row => row.id === id.slice(3));
    const or = url.searchParams.get('or');
    if (or) {
      const match = or.match(/updated_at\.gt\.(\d+),and\(updated_at\.eq\.(\d+),id\.gt\.(.*)\)/);
      if (!match) throw new Error(`unhandled cursor ${or}`);
      rows = rows.filter(row => row.updated_at > Number(match[1]) ||
        (row.updated_at === Number(match[2]) && row.id > match[3]));
    }
    const updated = url.searchParams.get('updated_at');
    if (updated) rows = rows.filter(row => updated.startsWith('gte.') ? row.updated_at >= Number(updated.slice(4)) : row.updated_at > Number(updated.slice(3)));
    return Response.json([...rows].sort((a, b) => a.updated_at - b.updated_at || (a.id < b.id ? -1 : 1))
      .slice(0, Number(url.searchParams.get('limit') ?? 500)));
  }));
});
afterEach(async () => {
  release?.(); await running?.catch(() => {});
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  __setSyncControlForTest(undefined); __resetSyncFlagsForTest();
  if (!db.isOpen()) await db.open(); await resetDb();
});

describe('confirmed reconnect atomic baseline upload', () => {
  it('persists the exact sorted remote projection including clear marker only when uploads are queued', async () => {
    await putLocal();
    cloud = [remote('product', 'z', { ...makeProduct('z') }, NOW - 1),
      remote('setting', 'deviceName', { key: 'deviceName', value: 'other phone' }),
      { id: `__ledger_cleared__:${CFG.ledgerKey}`, record_id: CFG.ledgerKey, kind: 'ledger',
        data: { clearedAt: NOW }, updated_at: NOW, record_updated_at: NOW, deleted: false }];
    const expected = projection(cloud);
    const preview = await prepareReconnect(CFG); await confirmReconnect(preview, {});
    expect(await meta.get(BASELINE_KEY)).toMatchObject({ operationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      generation: preview.generation + 1, expectedRows: expected });
    expect(canonicalJson(await meta.get(BASELINE_KEY))).not.toContain(CFG.anonKey);
  });

  it('uses the same exact raw expected projection as the actual PostgreSQL fixture', async () => {
    await putLocal(); cloud = structuredClone(sqlFixture.expectedRows) as CloudRow[];
    const preview = await prepareReconnect(CFG); await confirmReconnect(preview, { 'product:p1': 'local' });
    expect((await meta.get(BASELINE_KEY))?.expectedRows).toEqual(sqlFixture.expectedRows);
  });

  it('does not create a baseline for a remote-only union and does not infer deletion from remote absence', async () => {
    cloud = [remote('product', 'remote', { ...makeProduct('remote') }), remote('product', 'gone', {}, NOW, true)];
    const preview = await prepareReconnect(CFG); await confirmReconnect(preview, {});
    expect(await db.outbox.count()).toBe(0); expect(await meta.get(BASELINE_KEY)).toBeUndefined();
    await syncNow(CFG);
    expect(rpcBodies).toHaveLength(0);
    expect(calls.filter(call => call.init?.method === 'POST' && call.url.pathname.endsWith('/yh_records'))).toHaveLength(0);
  });

  it('choosing a local order queues delete only for that order remote-extra live lines', async () => {
    await db.orders.put(makeOrder('o1', 100, 's1', { lineIds: ['l1'] }));
    await db.lines.put(makeLine('l1', 'o1', 'p1', 1, 100));
    await db.products.put(makeProduct('local-only'));
    cloud = [remote('order', 'o1', { ...makeOrder('o1', 200, 's1', { lineIds: ['l2'] }) }),
      remote('line', 'l2', { ...makeLine('l2', 'o1', 'p2', 1, 200) }),
      remote('product', 'remote-only', { ...makeProduct('remote-only') }),
      remote('product', 'remote-dead', {}, NOW, true),
      remote('order', 'o2', { ...makeOrder('o2', 300, 's1', { lineIds: ['l3'] }) }),
      remote('line', 'l3', { ...makeLine('l3', 'o2', 'p3', 1, 300) })];
    const preview = await prepareReconnect(CFG); await confirmReconnect(preview, { 'order:o1': 'local' });
    const rows = await db.outbox.toArray();
    expect(rows.filter(row => row.op === 'delete')).toEqual([expect.objectContaining({ id: 'line:l2',
      op: 'delete', scope: SCOPE, clearEpoch: 0 })]);
    expect(rows.filter(row => row.op === 'upsert').map(row => row.id).sort()).toEqual(['line:l1', 'order:o1', 'product:local-only']);
    expect(await db.lines.get('l3')).toBeTruthy();
    await syncNow(CFG);
    expect(cloud.find(row => row.id === 'line:l2')).toMatchObject({ deleted: true });
    expect(cloud.find(row => row.id === 'line:l3')).toMatchObject({ deleted: false });
  });

  it('pauses with no remote mutation when another device updates after confirmation before RPC', async () => {
    await confirmLocal();
    cloud = [remote('product', 'p1', { ...makeProduct('p1', { priceList: 300 }) }, NOW + 10)];
    const queue = await db.outbox.toArray(); const before = structuredClone(cloud);
    await expect(syncNow(CFG)).rejects.toThrow(/重新连接基线已变化/);
    expect(cloud).toEqual(before); expect(await db.outbox.toArray()).toEqual(queue);
    expect(await db.products.get('p1')).toMatchObject({ priceList: 100 });
    expect(await readSyncControl()).toMatchObject({ paused: true, reason: expect.stringContaining('重新连接基线已变化') });
    expect(store.get('yh-sync-disabled')).toBe('1'); expect(await meta.get(BASELINE_KEY)).toBeTruthy();
    expect(calls.some(call => call.init?.method === 'POST' && call.url.pathname.endsWith('/yh_records'))).toBe(false);
  });

  it('retries a committed response-loss operation with its exact durable request across newer local/remote edits', async () => {
    await confirmLocal(); loseResponse = true;
    await expect(syncNow(CFG)).rejects.toThrow(/response lost|unknown|未知/);
    const first = structuredClone(rpcBodies[0]);
    expect(first).toBeTruthy(); expect(await meta.get(BASELINE_KEY)).toBeTruthy();
    expect(await readSyncControl()).toMatchObject({ paused: false });
    // Same id is edited remotely, a new remote record is added, and local queue revision advances.
    cloud[cloud.findIndex(row => row.id === 'product:p1')] = remote('product', 'p1', { ...makeProduct('p1', { priceList: 450 }) }, NOW + 20);
    cloud.push(remote('product', 'new-after-commit', { ...makeProduct('new-after-commit') }, NOW + 21));
    await editLocal(900); const newer = await db.outbox.get('product:p1');
    db.close(); await db.open(); __setSyncControlForTest(new SyncCoordinator(db, db.syncMeta));
    const result = await syncNow(CFG);
    expect(result.pushed).toBe(1); expect(rpcBodies).toHaveLength(2); expect(rpcBodies[1]).toEqual(first);
    expect(cloud.find(row => row.id === 'product:p1')?.data.priceList).toBe(450);
    expect(cloud.find(row => row.id === 'product:new-after-commit')?.deleted).toBe(false);
    expect(await db.outbox.get('product:p1')).toEqual(newer);
    expect(await db.products.get('p1')).toMatchObject({ priceList: 900 });
    expect(await meta.get(BASELINE_KEY)).toBeUndefined();
    expect(calls.some(call => call.init?.method === 'POST' && call.url.pathname.endsWith('/yh_records'))).toBe(false);
  });

  it('a newer local revision written during RPC survives the old receipt ACK', async () => {
    await confirmLocal(); const entered = gate(); const response = gate(); release = response.resolve;
    afterCommit = async () => { entered.resolve(); await response.promise; };
    const task = startSync(); await entered.promise; await editLocal(700);
    const newer = await db.outbox.get('product:p1'); response.resolve(); await task;
    expect(await db.outbox.get('product:p1')).toEqual(newer); expect(await meta.get(BASELINE_KEY)).toBeUndefined();
    expect(await db.products.get('p1')).toMatchObject({ priceList: 700 });
  });

  it('pause during RPC aborts the signal and prevents late ACK or baseline deletion', async () => {
    await confirmLocal(); const entered = gate(); const response = gate(); release = response.resolve;
    beforeRpc = async () => { entered.resolve(); await response.promise; };
    const task = startSync(); await entered.promise;
    const paused = await pauseSync('external pause'); response.resolve(); await expect(task).rejects.toThrow(/失效|lease/i);
    const rpc = calls.find(call => call.url.pathname.endsWith('/rpc/yh_reconcile_push'))!;
    expect(rpc.init?.signal?.aborted).toBe(true); expect(await db.outbox.count()).toBe(1);
    expect(await meta.get(BASELINE_KEY)).toBeTruthy(); await resumeSync(paused.generation);
  });

  it.each([false, true])('missing reconcile RPC pauses safely without regular POST fallback (legacy capabilities=%s)', async (useLegacy) => {
    store.set('yh-sync-url', CFG.url); store.set('yh-sync-anon', CFG.anonKey); store.set('yh-sync-ledger', CFG.ledgerKey);
    legacy = useLegacy; await confirmLocal(); rpcStatus = 404;
    await expect(syncNow(CFG)).rejects.toThrow(/重新连接基线已变化/);
    expect(store.get('yh-sync-disabled')).toBe('1'); expect(await readSyncControl()).toMatchObject({ paused: true });
    expect(await db.outbox.count()).toBe(1); expect(await meta.get(BASELINE_KEY)).toBeTruthy();
    expect(rpcBodies).toHaveLength(1);
    expect(calls.some(call => call.init?.method === 'POST' && call.url.pathname.endsWith('/yh_records'))).toBe(false);
  });

  it('rejects a missing upsert row rather than turning it into a remote tombstone', async () => {
    await confirmLocal(); await db.products.delete('p1');
    await expect(syncNow(CFG)).rejects.toThrow(/missing|缺失/);
    expect(rpcBodies).toHaveLength(0); expect(await db.outbox.count()).toBe(1);
    expect(await meta.get(BASELINE_KEY)).toBeTruthy(); expect(cloud[0].deleted).toBe(false);
  });

  it('disabling an already-paused reconnect preserves its recovery reason and generation', async () => {
    const paused = await pauseSync('restore requires reconnect confirmation');
    await clearSyncConfig();
    expect(await readSyncControl()).toMatchObject({ paused: true, generation: paused.generation, reason: paused.reason });
    expect(store.get('yh-sync-disabled')).toBe('1');
  });

  it('rejects adopting a stale conflict after a newer local edit', async () => {
    await putLocal();
    const conflict = await db.conflicts.add({ at: T0, kind: 'product', recordId: 'p1',
      local: JSON.stringify(makeProduct('p1')), remote: JSON.stringify(makeProduct('p1', { priceList: 500 })) });
    await editLocal(300);

    await expect(adoptRemoteConflict(conflict)).rejects.toThrow(/本机|修改|变化|新/);

    expect((await db.products.get('p1'))?.priceList).toBe(300);
    expect(await db.outbox.get('product:p1')).toBeTruthy();
    expect(await db.conflicts.get(conflict)).toBeTruthy();
  });

  it('rejects dropping a record after a newer same-generation local edit', async () => {
    await putLocal();
    const current = makeProduct('p1');
    await db.products.update('p1', { priceList: 300, updatedAt: new Date(NOW + 100).toISOString() });
    await expect(dropLocalRecord('product', 'p1', undefined, canonicalJson(current)))
      .rejects.toThrow(/修改|变化|新/);
    expect((await db.products.get('p1'))?.priceList).toBe(300);
  });

  it('rejects conflict adoption when content matches but the outbox revision is newer', async () => {
    await putLocal();
    const local = await db.products.get('p1');
    const conflict = await db.conflicts.add({ at: T0, kind: 'product', recordId: 'p1',
      local: JSON.stringify(local), remote: JSON.stringify(makeProduct('p1', { priceList: 500 })),
      localRevision: null });
    await db.transaction('rw', [db.outbox, db.syncMeta], () => enqueueInTx([{ kind: 'product', recordId: 'p1' }]));
    await expect(adoptRemoteConflict(conflict)).rejects.toThrow(/新修改|修改|变化/);
    expect((await db.products.get('p1'))?.priceList).toBe(100);
    expect(await db.conflicts.get(conflict)).toBeTruthy();
  });

  it('snapshot undo, conflict adoption, and record dropping reject writes during maintenance', async () => {
    await putLocal();
    const conflict = await db.conflicts.add({ at: T0, kind: 'product', recordId: 'p1',
      local: JSON.stringify(makeProduct('p1')), remote: JSON.stringify(makeProduct('p1', { priceList: 500 })) });
    await runMaintenance('restore', async () => {
      await expect(restoreLocalSnapshot({ type: 'overwritten', kind: 'product', recordId: 'p1', label: 'p1',
        local: { ...makeProduct('p1', { priceList: 600 }) } })).rejects.toThrow(/维护/);
      await expect(adoptRemoteConflict(Number(conflict))).rejects.toThrow(/维护/);
      await expect(dropLocalRecord('product', 'p1')).rejects.toThrow(/维护/);
    });
    expect(await db.products.get('p1')).toMatchObject({ priceList: 100 });
    expect(await db.conflicts.get(Number(conflict))).toBeTruthy(); expect(await db.outbox.count()).toBe(0);
  });

  it('a baseline-free queue keeps the existing regular upload path', async () => {
    await putLocal(); await db.transaction('rw', [db.outbox, db.syncMeta], () => enqueueInTx([{ kind: 'product', recordId: 'p1' }]));
    const result = await syncNow(CFG); expect(result.pushed).toBe(1); expect(await db.outbox.count()).toBe(0);
    expect(rpcBodies).toHaveLength(0);
    expect(calls.filter(call => call.init?.method === 'POST' && call.url.pathname.endsWith('/yh_records'))).toHaveLength(1);
  });
});
