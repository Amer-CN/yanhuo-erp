import { afterEach, expect, it } from 'vitest';
import { createMockServer } from '../scripts/mock-supabase.mjs';

const servers: ReturnType<typeof createMockServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});

it('accepts quoted parent ids without splitting commas, parentheses or escaped quotes', async () => {
  const server = createMockServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test port');
  const url = `http://127.0.0.1:${address.port}/rest/v1/yh_records`;
  const headers = { 'x-ledger-key': 'test-only', 'content-type': 'application/json' };
  const ids = ['plain-id', 'comma,id', 'paren(id)', 'quote"id', 'slash\\id'];
  const inserted = await fetch(`${url}?on_conflict=id`, {
    method: 'POST', headers,
    body: JSON.stringify(ids.map((record_id, i) => ({
      id: `order:${i}`, record_id, kind: 'order', ledger: 'test-only', data: {}, updated_at: i, deleted: false
    })))
  });
  expect(inserted.status).toBe(201);
  const quoted = ids.map((id) => `"${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',');
  const params = new URLSearchParams({ record_id: `in.(${quoted})`, select: 'record_id', order: 'id.asc' });
  const result = await fetch(`${url}?${params}`, { headers });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(ids.map((record_id) => ({ record_id })));
  for (const invalid of ['in.("unfinished)', 'in.("x"tail)', 'in.("x",)', 'in.(a,,b)']) {
    const response = await fetch(`${url}?${new URLSearchParams({ record_id: invalid })}`, { headers });
    expect(response.status, invalid).toBe(400);
  }
});
