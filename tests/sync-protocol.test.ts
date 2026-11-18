import 'fake-indexeddb/auto';
import Dexie, { type Table } from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { protocolScope, SyncProtocolClient, type SyncProtocolRow } from '../src/db/syncProtocol';
import type { SyncConfig } from '../src/db/syncTypes';

const CFG: SyncConfig = {
  url: 'https://example.supabase.co/',
  anonKey: 'sb_publishable_test',
  ledgerKey: 'ledger-a'
};
const V2 = {
  protocolVersion: 2,
  conflictTarget: 'ledger,id',
  ledgerScoped: true,
  clearRpcEnabled: true,
  clearEpoch: 42,
  epochHeader: 'x-yh-clear-epoch',
  epochHeaderRequired: true
} as const;

let name: string;
let dbs: Dexie[];
let db: Dexie;
let table: Table<SyncProtocolRow, string>;
let client: SyncProtocolClient;
let fetchMock: ReturnType<typeof vi.fn>;

async function connect(): Promise<{ db: Dexie; table: Table<SyncProtocolRow, string> }> {
  const connection = new Dexie(name);
  dbs.push(connection);
  connection.version(1).stores({ syncMeta: 'key' });
  await connection.open();
  return { db: connection, table: connection.table<SyncProtocolRow, string>('syncMeta') };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function capabilities(body: unknown = V2): void {
  fetchMock.mockResolvedValueOnce(json(body));
}

beforeEach(async () => {
  name = `sync-protocol-${crypto.randomUUID()}`;
  dbs = [];
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const connection = await connect();
  db = connection.db;
  table = connection.table;
  client = new SyncProtocolClient(db, table);
});

afterEach(async () => {
  dbs.forEach((connection) => connection.close());
  await Dexie.delete(name);
  vi.unstubAllGlobals();
});

describe('sync protocol capabilities', () => {
  it('canonicalizes endpoint identity while isolating ledger keys and excluding anon keys', () => {
    expect(protocolScope(CFG)).toBe(
      protocolScope({ ...CFG, url: 'https://example.supabase.co', anonKey: 'different' })
    );
    expect(protocolScope(CFG)).not.toBe(protocolScope({ ...CFG, ledgerKey: 'ledger-b' }));
    expect(protocolScope(CFG)).not.toContain(CFG.anonKey);
  });

  it('reads and validates v2 capabilities without persisting them', async () => {
    capabilities(V2);
    await expect(client.readProtocol(CFG)).resolves.toEqual(V2);
    expect(await table.toArray()).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.supabase.co/rest/v1/rpc/yh_sync_capabilities');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    expect(init.headers).toMatchObject({ apikey: CFG.anonKey, 'x-ledger-key': CFG.ledgerKey });
  });

  it('uses legacy capabilities only for the missing-RPC 404/PGRST202 response', async () => {
    fetchMock.mockResolvedValueOnce(json({ code: 'PGRST202', message: 'function not found' }, 404));
    await expect(client.readProtocol(CFG)).resolves.toEqual({
      protocolVersion: 1,
      conflictTarget: 'id',
      ledgerScoped: false,
      clearRpcEnabled: false,
      clearEpoch: 0,
      epochHeader: 'x-yh-clear-epoch',
      epochHeaderRequired: false
    });
  });

  it.each([
    ['network failure', () => fetchMock.mockRejectedValueOnce(new TypeError('offline'))],
    ['server error', () => fetchMock.mockResolvedValueOnce(json({ message: 'failed' }, 500))],
    ['malformed JSON', () => fetchMock.mockResolvedValueOnce(new Response('{', { status: 200 }))],
    ['wrong shape', () => fetchMock.mockResolvedValueOnce(json({ ...V2, clearEpoch: '42' }))],
    ['unrelated 404', () => fetchMock.mockResolvedValueOnce(json({ code: 'PGRST205' }, 404))]
  ])('does not downgrade on %s', async (_label, setup) => {
    setup();
    await expect(client.readProtocol(CFG)).rejects.toThrow();
  });

  it('does not let an epoch-zero legacy observation replace a stored v2 protocol', async () => {
    const v2 = { ...V2, clearEpoch: 0, epochHeaderRequired: false };
    const legacy = {
      protocolVersion: 1 as const,
      conflictTarget: 'id' as const,
      ledgerScoped: false as const,
      clearRpcEnabled: false as const,
      clearEpoch: 0 as const,
      epochHeader: 'x-yh-clear-epoch' as const,
      epochHeaderRequired: false as const
    };
    await client.storeProtocol(CFG, v2);
    await client.storeProtocol(CFG, legacy);
    expect(await table.get(`protocol:${protocolScope(CFG)}`)).toMatchObject({
      capabilities: { protocolVersion: 2 }
    });
  });

  it('stores only newer protocol observations and returns the stored clear epoch', async () => {
    await client.storeProtocol(CFG, V2);
    await client.storeProtocol(CFG, { ...V2, clearEpoch: 41 });
    expect(await client.readStoredProtocol(CFG)).toBe(42);
    await client.storeProtocol(CFG, {
      ...V2,
      protocolVersion: 1,
      conflictTarget: 'id',
      ledgerScoped: false,
      clearRpcEnabled: false,
      clearEpoch: 0,
      epochHeaderRequired: false
    });
    expect(await client.readStoredProtocol(CFG)).toBe(42);
  });
});

describe('idempotent ledger clear RPC', () => {
  it('refuses to issue clear RPC from inside a Dexie transaction', async () => {
    await expect(db.transaction('rw', table, () => client.clearLedgerRpc(CFG))).rejects.toThrow(
      /outside a Dexie transaction/i
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects legacy capability without creating a persisted operation or destructive request', async () => {
    fetchMock.mockResolvedValueOnce(json({ code: 'PGRST202' }, 404));
    await expect(client.clearLedgerRpc(CFG)).rejects.toThrow(/upgrade|protocol|v2/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await table.toArray()).toEqual([]);
  });

  it('reuses the write-ahead operation id after response loss and a database reopen', async () => {
    const receipt = { operationId: '', clearedAt: 1_800_000_000_000, clearedCount: 7, clearEpoch: 43 };
    let serverCommitted = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/yh_sync_capabilities')) return json(V2);
      const body = JSON.parse(String(init?.body)) as { p_operation_id: string };
      if (!serverCommitted) {
        serverCommitted = true;
        receipt.operationId = body.p_operation_id;
        throw new TypeError('response lost after commit');
      }
      expect(body.p_operation_id).toBe(receipt.operationId);
      return json(receipt);
    });

    await expect(client.clearLedgerRpc(CFG)).rejects.toThrow(/network|request|fetch|clear/i);
    const pending = await client.pendingClear(CFG);
    expect(pending).toMatchObject({ state: 'unknown', operationId: receipt.operationId });
    db.close();
    const reopened = await connect();
    db = reopened.db;
    table = reopened.table;
    client = new SyncProtocolClient(db, table);

    await expect(client.pendingClear(CFG)).resolves.toMatchObject({ operationId: receipt.operationId });
    await expect(client.clearLedgerRpc(CFG)).resolves.toMatchObject(receipt);
    expect(await client.pendingClear(CFG)).toMatchObject({ state: 'confirmed', ...receipt });
    fetchMock.mockRejectedValue(new TypeError('offline after confirmation'));
    await expect(client.clearLedgerRpc(CFG)).resolves.toMatchObject(receipt);
    await client.finishClearOperation(CFG, receipt.operationId);
    expect(await client.pendingClear(CFG)).toBeUndefined();
    const clearCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/yh_clear_ledger'));
    expect(clearCalls).toHaveLength(2);
    expect(clearCalls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).p_operation_id)).toEqual([
      receipt.operationId,
      receipt.operationId
    ]);
  });

  it('rejects finishing a confirmed clear operation with another id and preserves the receipt', async () => {
    const scope = protocolScope(CFG);
    const row: SyncProtocolRow = {
      key: `clear:${scope}`,
      kind: 'clear',
      scope,
      operationId: '00000000-0000-4000-8000-000000000001',
      state: 'confirmed',
      clearedAt: 1_800_000_000_000,
      clearedCount: 3,
      clearEpoch: 43
    };
    await table.put(row);

    await expect(client.finishClearOperation(CFG, '00000000-0000-4000-8000-000000000002')).rejects.toThrow(
      /operation id/i
    );
    expect(await client.pendingClear(CFG)).toEqual(row);
  });

  it('rejects finishing pending and unknown clear operations without changing their state', async () => {
    const scope = protocolScope(CFG);
    const operationId = '00000000-0000-4000-8000-000000000003';
    for (const state of ['pending', 'unknown'] as const) {
      const row: SyncProtocolRow = {
        key: `clear:${scope}`,
        kind: 'clear',
        scope,
        operationId,
        state,
        ...(state === 'unknown' ? { lastError: 'Outcome unknown; retry the same operation' } : {})
      };
      await table.put(row);

      await expect(client.finishClearOperation(CFG, operationId)).rejects.toThrow(/unconfirmed/i);
      expect(await client.pendingClear(CFG)).toEqual(row);
    }
  });

  it('does not issue the destructive clear RPC when the write-ahead database write fails', async () => {
    capabilities();
    const failure = new Error('write-ahead database failure');
    const failClearCreation = (_key: string, row: SyncProtocolRow): void => {
      if (row.kind === 'clear') throw failure;
    };
    table.hook('creating', failClearCreation);
    let result: unknown;
    try {
      result = await client.clearLedgerRpc(CFG).then(
        () => undefined,
        (error: unknown) => error
      );
    } finally {
      table.hook('creating').unsubscribe(failClearCreation);
    }

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://example.supabase.co/rest/v1/rpc/yh_sync_capabilities'
    ]);
    expect(result).toMatchObject({ message: 'write-ahead database failure' });
    expect(await client.pendingClear(CFG)).toBeUndefined();
  });

  it('keeps definite 4xx failures pending with a retryable error and the same operation id', async () => {
    const ids: ReturnType<typeof crypto.randomUUID>[] = ['00000000-0000-4000-8000-000000000004'];
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => ids.shift() ?? '00000000-0000-4000-8000-000000000005');
    let rpcCount = 0;
    let operationId = '';
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/yh_sync_capabilities')) return json(V2);
      rpcCount += 1;
      operationId = (JSON.parse(String(init?.body)) as { p_operation_id: string }).p_operation_id;
      if (rpcCount === 1) return json({ message: 'rejected' }, 403);
      return json({ operationId, clearedAt: 1_800_000_000_000, clearedCount: 0, clearEpoch: 43 });
    });

    await expect(client.clearLedgerRpc(CFG)).rejects.toThrow(/HTTP 403/);
    expect(await client.pendingClear(CFG)).toMatchObject({ state: 'pending', operationId, lastError: 'HTTP 403' });
    await expect(client.clearLedgerRpc(CFG)).resolves.toMatchObject({ operationId });
    expect(rpcCount).toBe(2);
    expect((await client.pendingClear(CFG))?.operationId).toBe(operationId);
  });

  it('rejects a receipt for another operation and never marks it confirmed', async () => {
    capabilities();
    fetchMock.mockResolvedValueOnce(
      json({
        operationId: '00000000-0000-4000-8000-000000000001',
        clearedAt: 1_800_000_000_000,
        clearedCount: 1,
        clearEpoch: 43
      })
    );
    await expect(client.clearLedgerRpc(CFG)).rejects.toThrow(/operation/i);
    expect(await client.pendingClear(CFG)).toMatchObject({ state: 'unknown' });
    expect((await client.pendingClear(CFG))?.state).not.toBe('confirmed');
  });

  it('keeps pending clear operations isolated between ledgers', async () => {
    const ids: ReturnType<typeof crypto.randomUUID>[] = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002'
    ];
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => ids.shift() ?? '00000000-0000-4000-8000-000000000003');
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/yh_sync_capabilities')) return json(V2);
      throw new TypeError('offline');
    });
    const other = { ...CFG, ledgerKey: 'ledger-b' };
    await expect(client.clearLedgerRpc(CFG)).rejects.toThrow();
    await expect(client.clearLedgerRpc(other)).rejects.toThrow();
    expect(await client.pendingClear(CFG)).toMatchObject({ operationId: '00000000-0000-4000-8000-000000000001' });
    expect(await client.pendingClear(other)).toMatchObject({ operationId: '00000000-0000-4000-8000-000000000002' });
  });
});
