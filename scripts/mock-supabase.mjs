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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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

/**
 * 游标条件：新客户端用复合游标
 * `or=(updated_at.gt.TS,and(updated_at.eq.TS,id.gt.ID))`，
 * 老客户端仍用单列 `updated_at=gt.TS|gte.TS`（模拟灰度混跑）。
 */
function cursorFilter(url) {
  const or = url.searchParams.get('or');
  if (or) {
    const m = /^\(updated_at\.gt\.(\d+),and\(updated_at\.eq\.(\d+),id\.gt\.(.*)\)\)$/.exec(or);
    if (m) {
      const gtTs = Number(m[1]);
      const eqTs = Number(m[2]);
      const gtId = m[3];
      return (r) =>
        Number(r.updated_at) > gtTs ||
        (Number(r.updated_at) === eqTs && String(r.id) > gtId);
    }
  }
  const raw = url.searchParams.get('updated_at');
  if (!raw) return () => true;
  const m = /^(gt|gte)\.(\d+)$/.exec(raw);
  if (!m) return () => true;
  const ts = Number(m[2]);
  return m[1] === 'gt'
    ? (r) => Number(r.updated_at) > ts
    : (r) => Number(r.updated_at) >= ts;
}

function compareRows(a, b) {
  const byTs = Number(a.updated_at) - Number(b.updated_at);
  if (byTs !== 0) return byTs;
  const ka = String(a.id);
  const kb = String(b.id);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
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
    const limit = Number(url.searchParams.get('limit') ?? '1000') || 1000;
    const after = cursorFilter(url);
    const list = [...rows.values()]
      .filter((r) => r.ledger === ledger && after(r))
      .sort(compareRows)
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

  // 软删除：与 v2 策略一致（anon 已无 DELETE 权限，清空账本走 PATCH deleted=true）
  if (req.method === 'PATCH') {
    const body = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: 'bad json' }));
      return;
    }
    const patch = Array.isArray(parsed) ? parsed[0] ?? {} : parsed;
    for (const [, row] of rows) {
      if (row.ledger === ledger) Object.assign(row, patch);
    }
    res.writeHead(204).end();
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