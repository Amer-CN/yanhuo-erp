// 本地假 Supabase（只实现同步用到的 REST 子集），用来验证自动同步。
// 运行：node scripts/mock-supabase.mjs [port]

import http from 'node:http';

const port = Number(process.argv[2] ?? 54321);
const rows = new Map(); // id -> row

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'apikey, authorization, content-type, prefer, x-ledger-key'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/rest/v1/yh_records')) {
    res.writeHead(404).end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const ledger = req.headers['x-ledger-key'] ?? '';

  if (req.method === 'GET') {
    const since = Number((url.searchParams.get('updated_at') ?? 'gt.0').replace('gt.', '')) || 0;
    const limit = Number(url.searchParams.get('limit') ?? '1000') || 1000;
    const list = [...rows.values()]
      .filter((r) => r.ledger === ledger && Number(r.updated_at) > since)
      .sort((a, b) => Number(a.updated_at) - Number(b.updated_at))
      .slice(0, limit);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(list));
    return;
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: 'bad json' }));
      return;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (item.ledger !== ledger) {
        res.writeHead(403).end(JSON.stringify({ error: 'ledger mismatch' }));
        return;
      }
      rows.set(item.id, { ...item });
    }
    res.writeHead(201).end();
    return;
  }

  if (req.method === 'DELETE') {
    for (const [id, row] of rows) {
      if (row.ledger === ledger) rows.delete(id);
    }
    res.writeHead(204).end();
    return;
  }

  res.writeHead(405).end(JSON.stringify({ error: 'method' }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock supabase on http://127.0.0.1:${port} (rest/v1/yh_records)`);
});