import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { db } from '../src/db/db';
import { saveSyncConfig } from '../src/db/sync';
import { pauseSync, readSyncControl, runMaintenance } from '../src/db/syncControl';
import { protocolScope } from '../src/db/syncProtocol';
import { prepareReconnect } from '../src/db/syncReconnect';
import { DEFAULT_SYNC } from '../src/db/syncDefaults';
import { makeProduct, resetDb } from './helpers';

const CFG = { url: 'http://127.0.0.1:54321', anonKey: 'test-key', ledgerKey: 'original' };
const TARGET = { ...CFG, ledgerKey: 'target' };
const V2 = { protocolVersion: 2, conflictTarget: 'ledger,id', ledgerScoped: true, clearRpcEnabled: true,
  clearEpoch: 0, epochHeader: 'x-yh-clear-epoch', epochHeaderRequired: false };
let store: Map<string, string>;
let runs: Promise<unknown>[];
let releases: (() => void)[];
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function capabilities(legacy: boolean) {
  return legacy ? Response.json({ code: 'PGRST202' }, { status: 404 }) : Response.json(V2);
}
beforeEach(async () => {
  await resetDb(); runs = []; releases = [];
  store = new Map([['yh-sync-disabled', '1'], ['yh-sync-url', CFG.url],
    ['yh-sync-anon', CFG.anonKey], ['yh-sync-ledger', CFG.ledgerKey]]);
  vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key) });
});
afterEach(async () => {
  releases.forEach(release => release()); await Promise.allSettled(runs);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); await resetDb();
});

it.each(['pause', 'completed-maintenance'] as const)(
  'save rejects a %s generation change during capability wait without replacing the pause or raw config', async mode => {
    const entered = gate(), release = gate(); releases.push(release.resolve);
    vi.stubGlobal('fetch', vi.fn(async () => { entered.resolve(); await release.promise; return capabilities(false); }));
    const before = [...store];
    const saving = saveSyncConfig(TARGET); void saving.catch(() => {}); runs.push(saving);
    await entered.promise;
    if (mode === 'pause') await pauseSync('restore');
    else await runMaintenance('restore', async () => {});
    const paused = await readSyncControl();
    release.resolve();
    await expect(saving).rejects.toThrow(/暂停|改变|确认|generation/i);
    expect(await readSyncControl()).toEqual(paused);
    expect([...store]).toEqual(before);
  });

it.each(['v1', 'v2-unscoped'] as const)(
  'direct reconnect rejects cross-scope %s before reading business rows or mutating the queue', async version => {
    await db.products.put(makeProduct('kept'));
    await db.outbox.put({ id: 'product:kept', kind: 'product', recordId: 'kept', op: 'upsert',
      queuedAt: 1 });
    const queue = await db.outbox.toArray();
    const paused = await pauseSync('restore');
    const reads = vi.spyOn(db.products, 'toArray');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(Dexie.currentTransaction).toBeFalsy();
      if (String(input).includes('/rpc/yh_sync_capabilities')) return version === 'v1' ? capabilities(true) :
        Response.json({ ...V2, ledgerScoped: false, clearRpcEnabled: false });
      return Response.json([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(prepareReconnect(TARGET)).rejects.toThrow(/scope|隔离|切换/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reads).not.toHaveBeenCalled();
    expect(await db.outbox.toArray()).toEqual(queue);
    expect(await readSyncControl()).toEqual(paused);
  });

it('prefers the persisted binding over stored config for legacy reconnect', async () => {
  await db.table('syncMeta').put({ key: 'sync-binding', kind: 'binding', scope: protocolScope(TARGET), clearEpoch: 0 });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('/rpc/') ? capabilities(true) : Response.json([])));
  await expect(prepareReconnect(TARGET)).resolves.toMatchObject({ scope: protocolScope(TARGET) });
});

it('uses the default config as the prior legacy scope when no explicit config exists', async () => {
  store.delete('yh-sync-url'); store.delete('yh-sync-anon'); store.delete('yh-sync-ledger');
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('/rpc/') ? capabilities(true) : Response.json([]));
  vi.stubGlobal('fetch', fetchMock);
  expect(protocolScope(DEFAULT_SYNC)).not.toBe(protocolScope(TARGET));
  await expect(prepareReconnect(TARGET)).rejects.toThrow(/scope|隔离|切换/i);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await readSyncControl()).toMatchObject({ paused: true });
});

it('continues allowing scoped v2 reconnect across ledgers', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('/rpc/') ? capabilities(false) : Response.json([])));
  await expect(prepareReconnect(TARGET)).resolves.toMatchObject({ scope: protocolScope(TARGET) });
});

it('leaves sync durably paused if saving localStorage fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => capabilities(false)));
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
  await expect(saveSyncConfig(TARGET)).rejects.toThrow('storage blocked');
  expect(await readSyncControl()).toMatchObject({ paused: true, reason: 'user' });
  expect(store.get('yh-sync-ledger')).toBe(CFG.ledgerKey);
});
