import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db/db';
import { backupDb } from '../src/db/backup';
import { clearCloud, clearCloudAndLocal } from '../src/db/sync';
import { pendingClear } from '../src/db/syncProtocol';
import { readSyncControl } from '../src/db/syncControl';
import { makeProduct, resetDb } from './helpers';
const cfg = { url: 'http://127.0.0.1:54321', anonKey: 'test-key', ledgerKey: 'clear-only' };
const cap = { protocolVersion: 2, conflictTarget: 'ledger,id', ledgerScoped: true, clearRpcEnabled: true,
  clearEpoch: 0, epochHeader: 'x-yh-clear-epoch', epochHeaderRequired: false };
let calls: { url: string; init?: RequestInit }[];
let rpcFail: boolean;
let legacy: boolean;
let lost: boolean;
let receipts: Map<string, { operationId: string; clearedAt: number; clearedCount: number; clearEpoch: number }>;
const store = new Map<string, string>();
beforeEach(async () => {
  await resetDb(); await db.syncMeta.clear(); await backupDb.snapshots.clear(); calls = []; rpcFail = false; legacy = false; lost = false; receipts = new Map(); store.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, String(v)), removeItem: (k: string) => store.delete(k) });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/rpc/yh_sync_capabilities')) return legacy ? Response.json({ code: 'PGRST202' }, { status: 404 }) : Response.json(cap);
    expect(String(url)).toBe(`${cfg.url}/rest/v1/rpc/yh_clear_ledger`);
    expect(init?.method).toBe('POST');
    if (rpcFail) return Response.json({ message: 'failed transaction' }, { status: 500 });
    const id = (JSON.parse(String(init?.body)) as { p_operation_id: string }).p_operation_id;
    const receipt = receipts.get(id) ?? { operationId: id, clearedAt: 2000, clearedCount: 1, clearEpoch: 2000 };
    receipts.set(id, receipt);
    if (lost) { lost = false; throw new TypeError('response lost'); }
    return Response.json(receipt);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });
describe('transactional cloud clear coordinator', () => {
  it('uses one ledger-bound RPC without PATCH/DELETE/marker writes', async () => {
    const receipt = await clearCloud(cfg);
    expect(receipt.clearEpoch).toBe(2000);
    expect(calls.filter(c => c.url.endsWith('/rpc/yh_clear_ledger'))).toHaveLength(1);
    expect(calls.every(c => c.init?.method === 'POST' && c.url.includes('/rpc/'))).toBe(true);
    expect(new Headers(calls[1].init?.headers).get('x-ledger-key')).toBe(cfg.ledgerKey);
    expect((await readSyncControl()).paused).toBe(true);
  });
  it('unsupported or failed clear keeps local data and never falls back', async () => {
    await db.products.put(makeProduct('kept')); legacy = true;
    await expect(clearCloudAndLocal(cfg)).rejects.toThrow(/upgrad|升级/i);
    expect(await db.products.get('kept')).toBeTruthy();
    expect(calls).toHaveLength(1);
    legacy = false; rpcFail = true;
    await expect(clearCloudAndLocal(cfg)).rejects.toThrow(/RPC|500/);
    expect(await db.products.get('kept')).toBeTruthy();
    expect((await pendingClear(cfg))?.state).toBe('unknown');
  });
  it('local completion survives finish failure and retry preserves later new local data', async () => {
    await db.products.put(makeProduct('old'));
    const fail = (key: unknown) => {
      if (String(key).startsWith('clear:')) throw new Error('finish failed');
    };
    db.syncMeta.hook('deleting', fail);
    try {
      await expect(clearCloudAndLocal(cfg)).rejects.toThrow('finish failed');
    } finally { db.syncMeta.hook('deleting').unsubscribe(fail); }
    expect(await db.products.count()).toBe(0);
    expect((await pendingClear(cfg))?.state).toBe('confirmed');
    await db.products.put(makeProduct('later'));
    const id = (await pendingClear(cfg))!.operationId;
    const receipt = await clearCloudAndLocal(cfg);
    expect(receipt.operationId).toBe(id);
    expect(await db.products.get('later')).toBeTruthy();
    expect(receipts.size).toBe(1);
    expect(await pendingClear(cfg)).toBeUndefined();
  });
  it('response loss retains one operation id; retry confirms it before clearing local', async () => {
    await db.products.put(makeProduct('kept')); lost = true;
    await expect(clearCloudAndLocal(cfg)).rejects.toThrow(/unknown/i);
    expect(await db.products.get('kept')).toBeTruthy();
    const unknown = await pendingClear(cfg);
    expect(unknown?.state).toBe('unknown');
    const receipt = await clearCloudAndLocal(cfg);
    expect(receipt.operationId).toBe(unknown?.operationId);
    expect(receipts.size).toBe(1);
    expect(await db.products.count()).toBe(0);
    expect(await pendingClear(cfg)).toBeUndefined();
    expect((await readSyncControl()).paused).toBe(true);
  });
});
