import { afterEach, describe, expect, it } from 'vitest';
import { createMockServer, type MockRequest, type MockServerOptions } from '../scripts/mock-supabase.mjs';

type TestServer = ReturnType<typeof createMockServer>;

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error: Error | undefined) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

async function start(options: MockServerOptions = {}) {
  const server = createMockServer(options);
  servers.push(server);
  expect(server.listening).toBe(false);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing loopback address');
  const origin = `http://127.0.0.1:${address.port}`;
  const request = (method: string, ledger: string | undefined, body?: unknown, query = '') => fetch(
    `${origin}/rest/v1/yh_records${query ? `?${query}` : ''}`,
    {
      method,
      headers: {
        ...(ledger === undefined ? {} : { 'x-ledger-key': ledger }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }
  );
  const read = async (ledger: string) => {
    const response = await request('GET', ledger, undefined, 'order=id.asc');
    expect(response.status).toBe(200);
    return response.json();
  };
  return { request, read };
}

function row(id: string, ledger = 'first', updatedAt = 100, kind = 'order') {
  return { id, ledger, record_id: id.split(':').pop(), kind, data: { value: id }, updated_at: updatedAt, deleted: false };
}

describe('mock Supabase HTTP contracts', () => {
  it('rejects an invalid ledger anywhere in a batch before writing any row', async () => {
    const api = await start();
    expect((await api.request('POST', 'first', row('original'), 'on_conflict=id')).status).toBe(201);
    const before = await api.read('first');
    const response = await api.request('POST', 'first', [row('new'), row('wrong', 'second')], 'on_conflict=id');
    expect(response.status).toBe(403);
    expect(await api.read('first')).toEqual(before);
    expect(await api.read('second')).toEqual([]);
  });

  it('rejects missing and empty ledger headers, including a matching empty payload ledger', async () => {
    const api = await start();
    for (const ledger of [undefined, '', '   ']) {
      expect((await api.request('POST', ledger, row('bad', ''))).status).toBe(403);
      expect((await api.request('GET', ledger)).status).toBe(403);
      expect((await api.request('PATCH', ledger, { deleted: true })).status).toBe(403);
    }
    expect(await api.read('first')).toEqual([]);
  });

  it('preserves both ledgers when a v1 batch collides with an existing foreign id', async () => {
    const api = await start();
    expect((await api.request('POST', 'first', row('shared'), 'on_conflict=id')).status).toBe(201);
    expect((await api.request('POST', 'second', row('own', 'second'), 'on_conflict=id')).status).toBe(201);
    const beforeFirst = await api.read('first');
    const beforeSecond = await api.read('second');
    const response = await api.request('POST', 'second', [row('new', 'second'), row('shared', 'second')], 'on_conflict=id');
    expect(response.status).toBe(403);
    expect(await api.read('first')).toEqual(beforeFirst);
    expect(await api.read('second')).toEqual(beforeSecond);
  });

  it('upserts the same ledger id without duplicating it', async () => {
    const api = await start();
    expect((await api.request('POST', 'first', row('one'), 'on_conflict=id')).status).toBe(201);
    const changed = { ...row('one', 'first', 200), data: { value: 'edited' } };
    expect((await api.request('POST', 'first', changed, 'on_conflict=id')).status).toBe(201);
    expect(await api.read('first')).toEqual([changed]);
  });

  it('allows the same id in separate ledgers only in v2 mode', async () => {
    const api = await start({ mode: 'v2' });
    expect((await api.request('POST', 'first', row('shared'), 'on_conflict=ledger,id')).status).toBe(201);
    expect((await api.request('POST', 'second', row('shared', 'second'), 'on_conflict=ledger,id')).status).toBe(201);
    expect(await api.read('first')).toEqual([row('shared')]);
    expect(await api.read('second')).toEqual([row('shared', 'second')]);
  });

  it('requires the conflict target that matches the selected schema mode', async () => {
    const v1 = await start();
    expect((await v1.request('POST', 'first', row('one'), 'on_conflict=id')).status).toBe(201);
    expect((await v1.request('POST', 'first', row('two'), 'on_conflict=ledger,id')).status).toBe(400);
    expect((await v1.request('POST', 'first', row('three'))).status).toBe(400);

    const v2 = await start({ mode: 'v2' });
    expect((await v2.request('POST', 'first', row('shared'), 'on_conflict=ledger,id')).status).toBe(201);
    expect((await v2.request('POST', 'second', row('shared', 'second'), 'on_conflict=id')).status).toBe(400);
    expect((await v2.request('POST', 'second', row('shared', 'second'))).status).toBe(400);
    expect(await v2.read('first')).toEqual([row('shared')]);
    expect(await v2.read('second')).toEqual([]);
  });

  it('filters before cursor pagination, applies id/ledger/kind and projects selected columns', async () => {
    const api = await start();
    const records = [
      row('order:a', 'first', 100, 'order'),
      row('line:a', 'first', 200, 'line'),
      row('order:b', 'first', 300, 'order'),
      row('order:foreign', 'second', 400, 'order')
    ];
    expect((await api.request('POST', 'first', records.slice(0, 3), 'on_conflict=id')).status).toBe(201);
    expect((await api.request('POST', 'second', records[3], 'on_conflict=id')).status).toBe(201);

    const idResponse = await api.request('GET', 'first', undefined, 'id=eq.order%3Aa&select=id,kind');
    expect(await idResponse.json()).toEqual([{ id: 'order:a', kind: 'order' }]);
    const inResponse = await api.request(
      'GET', 'first', undefined,
      'record_id=in.(a,b)&kind=eq.order&order=updated_at.desc,id.asc&limit=1&select=id,updated_at'
    );
    expect(await inResponse.json()).toEqual([{ id: 'order:b', updated_at: 300 }]);
    const cursorResponse = await api.request(
      'GET', 'first', undefined,
      'ledger=eq.first&or=(updated_at.gt.100,and(updated_at.eq.100,id.gt.order%3Aa))&order=updated_at.asc,id.asc&limit=1&select=id,record_id,kind,updated_at'
    );
    expect(await cursorResponse.json()).toEqual([{ id: 'line:a', record_id: 'a', kind: 'line', updated_at: 200 }]);
  });

  it('rejects unknown and method-inapplicable GET filters', async () => {
    const api = await start();
    expect((await api.request('GET', 'first', undefined, 'surprise=eq.true')).status).toBe(400);
    expect((await api.request('GET', 'first', undefined, 'on_conflict=id')).status).toBe(400);
    expect((await api.request('PATCH', 'first', { deleted: true }, 'on_conflict=id')).status).toBe(400);
    expect((await api.request('POST', 'first', row('unexpected'), 'on_conflict=id&id=eq.unexpected')).status).toBe(400);
  });

  it('patches only rows selected in the caller ledger', async () => {
    const api = await start({ mode: 'v2' });
    await api.request('POST', 'first', [row('one'), row('two')], 'on_conflict=ledger,id');
    await api.request('POST', 'second', row('other', 'second'), 'on_conflict=ledger,id');
    expect((await api.request('PATCH', 'first', { deleted: true }, 'ledger=eq.first&id=eq.one')).status).toBe(204);
    expect(await api.read('first')).toEqual([{ ...row('one'), deleted: true }, row('two')]);
    expect(await api.read('second')).toEqual([row('other', 'second')]);
  });

  it('rejects ledger reassignment before modifying any selected row', async () => {
    const api = await start();
    await api.request('POST', 'first', [row('one'), row('two')], 'on_conflict=id');
    const before = await api.read('first');
    expect((await api.request('PATCH', 'first', { deleted: true, ledger: 'second' }, 'ledger=eq.first')).status).toBe(403);
    expect(await api.read('first')).toEqual(before);
    expect(await api.read('second')).toEqual([]);
  });

  it('rejects malformed or duplicate filters instead of ignoring part of the request', async () => {
    const api = await start();
    await api.request('POST', 'first', row('order:a'), 'on_conflict=id');
    for (const query of ['record_id=in.(a,b', 'record_id=in.(a,,b)', 'id=eq.order%3Aa&id=unknown.bad', 'select=id&select=missing']) {
      expect((await api.request('GET', 'first', undefined, query)).status, query).toBe(400);
    }
  });

  it('rejects unsupported PATCH controls without writing data', async () => {
    const api = await start();
    await api.request('POST', 'first', row('one'), 'on_conflict=id');
    for (const query of ['id=eq.one&limit=bad', 'id=eq.one&order=bad', 'id=eq.one&select=missing']) {
      expect((await api.request('PATCH', 'first', { deleted: true }, query)).status, query).toBe(400);
    }
    expect(await api.read('first')).toEqual([row('one')]);
  });

  it('refuses physical deletion', async () => {
    const api = await start();
    await api.request('POST', 'first', row('one'), 'on_conflict=id');
    expect((await api.request('DELETE', 'first')).status).toBe(403);
    expect(await api.read('first')).toEqual([row('one')]);
  });

  it('supports a request gate, injected failure and request journal', async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seenGate = new Promise<void>((resolve) => { entered = resolve; });
    const journal: MockRequest[] = [];
    const api = await start({
      onRequest: (request) => journal.push(request),
      beforeRequest: async (request) => {
        if (request.path === '/rest/v1/yh_records' && request.query.get('id') === 'eq.wait') {
          entered?.();
          await gate;
        }
      },
      failRequest: (request) => request.query.get('id') === 'eq.fail'
        ? { status: 503, body: { error: 'injected' } }
        : null
    });
    const pending = api.request('GET', 'first', undefined, 'id=eq.wait');
    await seenGate;
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ method: 'GET', ledger: 'first' });
    release?.();
    expect((await pending).status).toBe(200);
    expect((await api.request('GET', 'first', undefined, 'id=eq.fail')).status).toBe(503);
    expect(journal).toHaveLength(2);
  });

});
