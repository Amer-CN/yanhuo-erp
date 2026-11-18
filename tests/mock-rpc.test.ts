import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockServer, type MockRequest, type MockServerOptions } from '../scripts/mock-supabase.mjs';

// This project has no @types/node dependency; keep the native test adapters local.
interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  setEncoding(encoding: string): void;
  on(event: 'data', callback: (chunk: string) => void): void;
  on(event: 'error', callback: (error: Error) => void): void;
  on(event: 'end', callback: () => void): void;
}
interface CliProcess {
  stdout: { on(event: 'data', callback: (chunk: unknown) => void): void };
  stderr: { on(event: 'data', callback: (chunk: unknown) => void): void };
  exitCode: number | null;
  on(event: 'error', callback: (error: Error) => void): void;
  on(event: 'exit', callback: () => void): void;
  kill(): void;
}
const { request: httpRequest } = await vi.importActual<{
  request(url: string, options: { method: string; headers: Record<string, string> }, callback: (response: HttpResponse) => void): {
    on(event: 'error', callback: (error: Error) => void): void;
    end(body?: string): void;
  };
}>('node:http');
const { spawn } = await vi.importActual<{
  spawn(executable: string, args: string[], options: { env: Record<string, string | undefined>; stdio: string[] }): CliProcess;
}>('node:child_process');
const { default: nodeProcess } = await vi.importActual<{
  default: { execPath: string; env: Record<string, string | undefined> };
}>('node:process');
const { fileURLToPath } = await vi.importActual<{ fileURLToPath(url: URL): string }>('node:url');

const TABLE = '/rest/v1/yh_records';
const CAPABILITIES = '/rest/v1/rpc/yh_sync_capabilities';
const CLEAR = '/rest/v1/rpc/yh_clear_ledger';
const OPERATION = '00000000-0000-4000-8000-000000000001';
const NEXT_OPERATION = '00000000-0000-4000-8000-000000000002';
const servers: ReturnType<typeof createMockServer>[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

async function start(options: MockServerOptions = { mode: 'v2' }) {
  const server = createMockServer(options);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  const request = (path: string, method = 'GET', ledger: string | undefined | null = 'first', body?: unknown, epoch?: string) => new Promise<Response>((resolve, reject) => {
    // Node HTTP avoids fetch's forbidden-port list for OS-assigned loopback test ports.
    const req = httpRequest(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: {
        ...(ledger == null ? {} : { 'x-ledger-key': ledger }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(epoch === undefined ? {} : { 'x-yh-clear-epoch': epoch })
      }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve(new Response([204, 304].includes(res.statusCode!) ? null : text, {
        status: res.statusCode, headers: res.headers as Record<string, string>
      })));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const read = async (ledger = 'first', query = 'order=id.asc') => {
    const result = await request(`${TABLE}?${query}`, 'GET', ledger);
    expect(result.status).toBe(200);
    return result.json();
  };
  const insert = (body: unknown, ledger = 'first', epoch?: number | string) => request(
    `${TABLE}?on_conflict=${options.mode === 'v2' ? 'ledger,id' : 'id'}`,
    'POST', ledger, body, epoch === undefined ? undefined : String(epoch)
  );
  const clear = (operationId = OPERATION, ledger = 'first') => request(CLEAR, 'POST', ledger, { p_operation_id: operationId });
  const capabilities = async (ledger = 'first') => {
    const result = await request(CAPABILITIES, 'POST', ledger, {});
    expect(result.status).toBe(200);
    return result.json();
  };
  return { request, read, insert, clear, capabilities };
}

function row(id: string, ledger = 'first', extra: Record<string, unknown> = {}) {
  return {
    id, record_id: id, ledger, kind: 'order', data: { value: id },
    updated_at: 10, record_updated_at: 10, schema_version: 2, device_id: 'test-device', deleted: false,
    ...extra
  };
}

async function expectMismatch(response: Response) {
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'SYNC_CLEAR_EPOCH_MISMATCH' });
}

describe('mock RPC HTTP protocol', () => {
  it('defaults to v1 and returns PGRST202 for capability discovery without requiring epochs', async () => {
    const api = await start({});
    const response = await api.request(CAPABILITIES, 'POST', 'first', {});
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'PGRST202' });
    expect((await api.insert(row('old-client'))).status).toBe(201);
    expect((await api.request(TABLE, 'PATCH', 'first', { deleted: true })).status).toBe(204);
    expect(await api.read()).toEqual([row('old-client', 'first', { deleted: true })]);
  });

  it('advertises the SQL v2 contract and keeps a shared id scoped to its ledger', async () => {
    const api = await start();
    expect(await api.capabilities()).toEqual({
      protocolVersion: 2, conflictTarget: 'ledger,id', ledgerScoped: true, clearRpcEnabled: true,
      clearEpoch: 0, epochHeader: 'x-yh-clear-epoch', epochHeaderRequired: false
    });
    expect((await api.insert(row('same', 'first', { clear_epoch: 0 }))).status).toBe(201);
    expect((await api.insert(row('same', 'second', { clear_epoch: 0 }), 'second')).status).toBe(201);
    expect(await api.read('first', 'select=id,ledger,clear_epoch')).toEqual([{ id: 'same', ledger: 'first', clear_epoch: 0 }]);
    expect(await api.read('second')).toEqual([row('same', 'second', { clear_epoch: 0 })]);
    const foreignBatch = await api.insert([row('new'), row('bad', 'second')]);
    expect(foreignBatch.status).toBe(403);
    expect(await api.read('first')).toHaveLength(1);
  });

  it('requires a nonempty ledger for both v2 RPCs', async () => {
    const api = await start();
    for (const ledger of [null, '', '   ']) {
      const capability = await api.request(CAPABILITIES, 'POST', ledger, {});
      expect(capability.status).toBe(403);
      expect((await api.request(CLEAR, 'POST', ledger, { p_operation_id: OPERATION })).status).toBe(403);
    }
    expect(await api.capabilities()).toMatchObject({ clearEpoch: 0 });
  });

  it('clears all ledger rows atomically and returns a scoped SQL receipt and live marker', async () => {
    const api = await start();
    const original = [row('order'), row('deleted', 'first', { deleted: true }), row('setting', 'first', { kind: 'setting' })];
    expect((await api.insert(original)).status).toBe(201);
    expect((await api.insert(row('order', 'second'), 'second')).status).toBe(201);
    const foreign = await api.read('second');
    const response = await api.clear();
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt).toEqual({ operationId: OPERATION, clearedAt: expect.any(Number), clearedCount: 2, clearEpoch: expect.any(Number) });
    expect(receipt.clearEpoch).toBeGreaterThan(0);
    expect(receipt.clearEpoch).toBeGreaterThanOrEqual(receipt.clearedAt);
    const cleared = await api.read();
    for (const originalRow of original) {
      expect(cleared.find((entry: { id: string }) => entry.id === originalRow.id)).toEqual({
        ...originalRow, deleted: true, updated_at: receipt.clearedAt,
        record_updated_at: receipt.clearedAt, clear_epoch: receipt.clearEpoch
      });
    }
    const markerId = '__ledger_cleared__:first';
    expect(cleared.find((entry: { id: string }) => entry.id === markerId)).toEqual({
      id: markerId, record_id: markerId, ledger: 'first', kind: 'ledger',
      data: { clearedAt: receipt.clearedAt, clearEpoch: receipt.clearEpoch },
      updated_at: receipt.clearedAt, record_updated_at: receipt.clearedAt,
      schema_version: 2, clear_epoch: receipt.clearEpoch, device_id: '', deleted: false
    });
    expect(await api.capabilities()).toMatchObject({ clearEpoch: receipt.clearEpoch, epochHeaderRequired: true });
    expect(await api.capabilities('second')).toMatchObject({ clearEpoch: 0, epochHeaderRequired: false });
    expect(await api.read('second')).toEqual(foreign);
  });

  it('validates the operation UUID before modifying rows, state or receipts', async () => {
    const api = await start();
    await api.insert(row('untouched'));
    const before = await api.read();
    for (const body of [{}, { p_operation_id: null }, { p_operation_id: 'not-a-uuid' }, []]) {
      expect((await api.request(CLEAR, 'POST', 'first', body)).status).toBe(400);
    }
    expect((await api.request(CLEAR)).status).toBe(405);
    expect(await api.read()).toEqual(before);
    expect(await api.capabilities()).toMatchObject({ clearEpoch: 0 });
    const valid = await api.clear();
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ operationId: OPERATION, clearedCount: 1 });
  });

  it('keeps repeat receipts stable without deleting new rows, even after another clear', async () => {
    const api = await start();
    await api.insert(row('before'));
    const firstResponse = await api.clear();
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    const added = row('after', 'first', { clear_epoch: first.clearEpoch });
    expect((await api.insert(added, 'first', first.clearEpoch)).status).toBe(201);
    const beforeRetry = await api.read();
    const retry = await api.clear();
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(first);
    expect(await api.read()).toEqual(beforeRetry);
    const second = await (await api.clear(NEXT_OPERATION)).json();
    expect(second.clearedCount).toBe(1);
    expect(second.clearEpoch).toBeGreaterThan(first.clearEpoch);
    const latest = row('latest', 'first', { clear_epoch: second.clearEpoch });
    expect((await api.insert(latest, 'first', second.clearEpoch)).status).toBe(201);
    const afterSecond = await api.read();
    expect(await (await api.clear()).json()).toEqual(first);
    expect(await api.read()).toEqual(afterSecond);
    await api.insert(row('foreign', 'second'), 'second');
    const foreignReceipt = await (await api.clear(OPERATION, 'second')).json();
    expect(foreignReceipt.clearedCount).toBe(1);
    expect(await api.read()).toEqual(afterSecond);
  });

  it('advances state epochs monotonically if the wall clock stalls or moves backwards', async () => {
    const api = await start();
    vi.spyOn(Date, 'now').mockReturnValue(2000);
    const firstResponse = await api.clear();
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first).toMatchObject({ clearedAt: 2000, clearEpoch: 2000, clearedCount: 0 });
    vi.mocked(Date.now).mockReturnValue(1000);
    const second = await (await api.clear(NEXT_OPERATION)).json();
    expect(second).toMatchObject({ clearedAt: 1000, clearEpoch: 2001, clearedCount: 0 });
    expect(await api.capabilities()).toMatchObject({ clearEpoch: 2001 });
  });

  it('rejects stale, absent and invalid epoch payloads and headers before writing any POST batch', async () => {
    const api = await start();
    const validAtZero = row('at-zero');
    expect((await api.insert(validAtZero)).status).toBe(201);
    expect((await api.request(`${TABLE}?id=eq.at-zero`, 'PATCH', 'first', { deleted: true })).status).toBe(204);
    await expectMismatch(await api.insert(row('wrong-at-zero', 'first', { clear_epoch: 1 })));
    await expectMismatch(await api.insert(row('wrong-header-at-zero'), 'first', '00'));
    const clearResponse = await api.clear();
    expect(clearResponse.status).toBe(200);
    const { clearEpoch } = await clearResponse.json();
    const before = await api.read();
    const valid = row('current', 'first', { clear_epoch: clearEpoch });
    for (const [payloadEpoch, header] of [
      [undefined, undefined], [0, String(clearEpoch)], [clearEpoch, undefined],
      [clearEpoch, String(clearEpoch - 1)], [String(clearEpoch), String(clearEpoch)],
      [clearEpoch, 'bad'], [clearEpoch, `0${clearEpoch}`]
    ] as const) {
      const invalid = row('invalid', 'first', payloadEpoch === undefined ? {} : { clear_epoch: payloadEpoch });
      await expectMismatch(await api.insert([valid, invalid], 'first', header));
      expect(await api.read()).toEqual(before);
    }
    expect((await api.insert(valid, 'first', clearEpoch)).status).toBe(201);
    expect(await api.read('first', 'id=eq.current&select=id,clear_epoch')).toEqual([{ id: 'current', clear_epoch: clearEpoch }]);
  });

  it('requires explicit current epoch proof for PATCH and keeps unmatched ledgers untouched', async () => {
    const api = await start();
    await api.insert([row('one'), row('two')]);
    await api.insert(row('one', 'second'), 'second');
    const clearResponse = await api.clear();
    expect(clearResponse.status).toBe(200);
    const { clearEpoch } = await clearResponse.json();
    const before = await api.read();
    for (const [patch, header] of [
      [{ deleted: false }, String(clearEpoch)],
      [{ deleted: false, clear_epoch: clearEpoch }, undefined],
      [{ deleted: false, clear_epoch: 0 }, String(clearEpoch)],
      [{ deleted: false, clear_epoch: clearEpoch }, String(clearEpoch - 1)]
    ] as const) {
      await expectMismatch(await api.request(`${TABLE}?kind=eq.order`, 'PATCH', 'first', patch, header));
      expect(await api.read()).toEqual(before);
    }
    expect((await api.request(`${TABLE}?id=eq.one`, 'PATCH', 'first', { deleted: false, clear_epoch: clearEpoch }, String(clearEpoch))).status).toBe(204);
    expect((await api.read()).find((entry: { id: string }) => entry.id === 'one')).toMatchObject({ deleted: false, clear_epoch: clearEpoch });
    expect((await api.read()).find((entry: { id: string }) => entry.id === 'two')).toMatchObject({ deleted: true });
    expect(await api.read('second')).toEqual([row('one', 'second')]);
  });

  it('permits the epoch header in CORS preflight', async () => {
    const api = await start();
    const response = await api.request(CLEAR, 'OPTIONS');
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers')?.split(',').map((value) => value.trim())).toContain('x-yh-clear-epoch');
  });

  it('keeps gated clear failures atomic across business rows, marker, state and receipt', async () => {
    let release!: () => void;
    let entered!: () => void;
    let rejectClear = true;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen = new Promise<void>((resolve) => { entered = resolve; });
    const journal: MockRequest[] = [];
    const api = await start({
      mode: 'v2',
      onRequest: (request) => { journal.push(request); },
      beforeRequest: async (request) => {
        if (request.path === CLEAR && rejectClear) { entered(); await gate; }
      },
      failRequest: (request) => request.path === CLEAR && rejectClear
        ? { status: 503, body: { error: 'clear transaction rejected' } } : null
    });
    await api.insert([row('one'), row('two')]);
    await api.insert(row('other', 'second'), 'second');
    const before = await api.read();
    const foreign = await api.read('second');
    const pending = api.clear();
    await seen;
    expect(journal.at(-1)).toMatchObject({ path: CLEAR, method: 'POST', ledger: 'first' });
    expect(await api.read()).toEqual(before);
    expect(await api.capabilities()).toMatchObject({ clearEpoch: 0 });
    release();
    const failed = await pending;
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'clear transaction rejected' });
    expect(await api.read()).toEqual(before);
    expect(await api.read('second')).toEqual(foreign);
    expect(await api.capabilities()).toMatchObject({ clearEpoch: 0 });
    rejectClear = false;
    const retried = await api.clear();
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ operationId: OPERATION, clearedCount: 2 });
  });

  it.each(['v1', 'v2'] as const)('selects CLI schema mode from MOCK_SCHEMA_MODE=%s', async (mode) => {
    const child = spawn(nodeProcess.execPath, [fileURLToPath(new URL('../scripts/mock-supabase.mjs', import.meta.url)), '0'], {
      env: { ...nodeProcess.env, MOCK_SCHEMA_MODE: mode === 'v2' ? mode : '' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    const exited = new Promise<void>((resolve) => { child.on('exit', resolve); });
    let output = '';
    try {
      const origin = await new Promise<string>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', () => reject(new Error(`CLI exited before listening: ${output}`)));
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.stdout.on('data', (chunk) => {
          output += chunk;
          const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
          if (match) resolve(match[0]);
        });
      });
      const response = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const req = httpRequest(`${origin}${CAPABILITIES}`, { method: 'POST', headers: { 'x-ledger-key': 'cli-test' } }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end('{}');
      });
      expect(response.status).toBe(mode === 'v2' ? 200 : 404);
      expect(response.body).toMatchObject(mode === 'v2' ? { protocolVersion: 2, clearEpoch: 0 } : { code: 'PGRST202' });
    } finally {
      if (child.exitCode === null) child.kill();
      await exited;
    }
  });

  it('returns a JSON 500 for a throwing request journal and keeps the server usable', async () => {
    let throwOnce = true;
    const api = await start({ mode: 'v2', onRequest: () => {
      if (throwOnce) { throwOnce = false; throw new Error('journal failed'); }
    } });
    const response = await api.request(CAPABILITIES, 'POST', 'first', {});
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'journal failed' });
    expect(await api.capabilities()).toMatchObject({ clearEpoch: 0 });
  });
});
