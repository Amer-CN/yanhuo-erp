// 本地假 Supabase（只实现同步用到的 REST 子集），用来验证自动同步。
// 运行：node scripts/mock-supabase.mjs [port]

import http from 'node:http';
import { pathToFileURL } from 'node:url';

const TABLE_PATH = '/rest/v1/yh_records';
const FILTER_KEYS = new Set(['ledger', 'id', 'record_id', 'kind', 'or', 'updated_at', 'order', 'limit', 'select']);
const COLUMNS = new Set(['id', 'record_id', 'ledger', 'kind', 'data', 'updated_at', 'record_updated_at', 'schema_version', 'device_id', 'deleted']);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'apikey, authorization, content-type, prefer, x-ledger-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}

function response(res, status, body) {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseFilter(value, operators) {
  const match = /^(eq|gt|gte)\.(.*)$/.exec(value);
  if (!match || !operators.has(match[1])) return null;
  return { op: match[1], value: match[2] };
}

function queryPredicate(url, allowedKeys = FILTER_KEYS) {
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key)) return { error: `unsupported filter: ${key}` };
  }
  const filters = [];
  for (const key of ['ledger', 'id', 'record_id', 'kind']) {
    const raw = url.searchParams.get(key);
    if (raw === null) continue;
    const inMatch = key === 'record_id' ? /^in\.\(([^()]*)\)$/.exec(raw) : null;
    const values = inMatch?.[1].split(',').map((value) => value.trim());
    if (raw.startsWith('in.') && (!values || values.some((value) => !value || /["\\]/.test(value)))) {
      return { error: `unsupported ${key} in filter` };
    }
    const parsed = values
      ? { op: 'in', value: values }
      : parseFilter(raw, new Set(['eq']));
    if (!parsed) return { error: `unsupported ${key} filter` };
    filters.push((row) => parsed.op === 'in'
      ? parsed.value.includes(String(row[key]))
      : String(row[key]) === parsed.value);
  }
  const updated = url.searchParams.get('updated_at');
  if (updated !== null) {
    const parsed = parseFilter(updated, new Set(['gt', 'gte']));
    if (!parsed || !/^\d+$/.test(parsed.value)) return { error: 'unsupported updated_at filter' };
    const cursor = Number(parsed.value);
    filters.push((row) => parsed.op === 'gt' ? Number(row.updated_at) > cursor : Number(row.updated_at) >= cursor);
  }
  const composite = url.searchParams.get('or');
  if (composite !== null) {
    const match = /^\(updated_at\.gt\.(\d+),and\(updated_at\.eq\.(\d+),id\.gt\.([^)]*)\)\)$/.exec(composite);
    if (!match) return { error: 'unsupported composite cursor' };
    const gtTs = Number(match[1]);
    const eqTs = Number(match[2]);
    const gtId = match[3];
    filters.push((row) => Number(row.updated_at) > gtTs || (Number(row.updated_at) === eqTs && String(row.id) > gtId));
  }
  return { test: (row) => filters.every((filter) => filter(row)) };
}

function orderRows(url, rows) {
  const order = url.searchParams.get('order');
  if (!order) return rows.sort(compareRows);
  const clauses = order.split(',').map((part) => {
    const match = /^(id|updated_at|record_id|kind)\.(asc|desc)$/.exec(part);
    return match && { field: match[1], descending: match[2] === 'desc' };
  });
  if (clauses.some((clause) => !clause)) return null;
  return rows.sort((a, b) => {
    for (const clause of clauses) {
      const left = a[clause.field];
      const right = b[clause.field];
      const compared = clause.field === 'updated_at'
        ? Number(left) - Number(right)
        : String(left ?? '') < String(right ?? '') ? -1 : String(left ?? '') > String(right ?? '') ? 1 : 0;
      if (compared) return clause.descending ? -compared : compared;
    }
    return compareRows(a, b);
  });
}

function compareRows(a, b) {
  const byTs = Number(a.updated_at) - Number(b.updated_at);
  if (byTs !== 0) return byTs;
  return String(a.id).localeCompare(String(b.id));
}

function projectRows(rows, url) {
  const select = url.searchParams.get('select');
  if (!select || select === '*') return rows;
  const columns = select.split(',').map((column) => column.trim());
  if (columns.some((column) => !COLUMNS.has(column))) return null;
  return rows.map((row) => Object.fromEntries(columns.filter((column) => column in row).map((column) => [column, row[column]])));
}

function normalizeResult(result) {
  if (result === false) return { status: 503, body: { error: 'injected failure' } };
  if (typeof result === 'number') return { status: result, body: { error: 'injected failure' } };
  if (result && typeof result === 'object' && Number.isInteger(result.status)) return result;
  return null;
}

export function createMockServer(options = {}) {
  const mode = options.mode ?? 'v1';
  if (!['v1', 'v2'].includes(mode)) throw new TypeError(`unsupported mock mode: ${mode}`);
  const rows = new Map();
  const keyOf = (row) => mode === 'v1' ? String(row.id) : `${row.ledger}\0${row.id}`;

  return http.createServer(async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') return response(res, 204);

    const url = new URL(req.url, 'http://127.0.0.1');
    const parameterNames = [...url.searchParams.keys()];
    if (new Set(parameterNames).size !== parameterNames.length) {
      return response(res, 400, { error: 'duplicate query parameter' });
    }
    const ledger = String(req.headers['x-ledger-key'] ?? '').trim();
    const request = { method: req.method, path: url.pathname, query: url.searchParams, ledger };
    options.onRequest?.(request);
    try {
      await options.beforeRequest?.(request);
      const injected = normalizeResult(await options.failRequest?.(request));
      if (injected) return response(res, injected.status, injected.body);
    } catch (error) {
      return response(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }

    if (url.pathname !== TABLE_PATH) return response(res, 404, { error: 'not found' });
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) return response(res, 405, { error: 'method' });
    if (!ledger) return response(res, 403, { error: 'ledger header required' });

    if (req.method === 'DELETE') return response(res, 403, { error: 'physical deletion is disabled' });

    if (req.method === 'GET') {
      const predicate = queryPredicate(url);
      if (predicate.error) return response(res, 400, { error: predicate.error });
      const limitRaw = url.searchParams.get('limit') ?? '1000';
      if (!/^\d+$/.test(limitRaw)) return response(res, 400, { error: 'invalid limit' });
      const ordered = orderRows(url, [...rows.values()].filter((row) => row.ledger === ledger && predicate.test(row)));
      if (!ordered) return response(res, 400, { error: 'unsupported order' });
      const projected = projectRows(ordered.slice(0, Number(limitRaw)), url);
      if (!projected) return response(res, 400, { error: 'unsupported select' });
      return response(res, 200, projected);
    }

    if (req.method === 'POST') {
      const unexpected = [...url.searchParams.keys()].find((key) => key !== 'on_conflict');
      if (unexpected) return response(res, 400, { error: `unsupported POST parameter: ${unexpected}` });
      const conflictTarget = url.searchParams.get('on_conflict');
      if (mode === 'v1' && conflictTarget !== 'id') {
        return response(res, 400, { error: 'v1 conflict target must be id' });
      }
      if (mode === 'v2' && conflictTarget !== 'ledger,id') {
        return response(res, 400, { error: 'v2 conflict target must be ledger,id' });
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return response(res, 400, { error: 'bad json' });
      }
      const items = Array.isArray(payload) ? payload : [payload];
      if (!items.length || items.some((item) => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id.trim() || item.ledger !== ledger)) {
        return response(res, 403, { error: 'ledger mismatch or invalid row' });
      }
      const staged = new Map();
      for (const item of items) {
        const key = keyOf(item);
        const current = staged.get(key) ?? rows.get(key);
        if (current && current.ledger !== ledger) return response(res, 403, { error: 'id belongs to another ledger' });
        staged.set(key, { ...current, ...item });
      }
      for (const [key, row] of staged) rows.set(key, row);
      return response(res, 201);
    }

    let patch;
    try {
      patch = JSON.parse(await readBody(req));
    } catch {
      return response(res, 400, { error: 'bad json' });
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return response(res, 400, { error: 'invalid patch' });
    const predicate = queryPredicate(url, new Set(['ledger', 'id', 'record_id', 'kind', 'or', 'updated_at']));
    if (predicate.error) return response(res, 400, { error: predicate.error });
    if ('ledger' in patch && patch.ledger !== ledger) {
      return response(res, 403, { error: 'ledger reassignment violates row policy' });
    }
    if ('id' in patch) return response(res, 400, { error: 'primary key patches are unsupported' });
    for (const [key, row] of rows) {
      if (row.ledger !== ledger || !predicate.test(row)) continue;
      const next = { ...row, ...patch };
      rows.set(key, next);
    }
    return response(res, 204);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 54321);
  const server = createMockServer();
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const actualPort = address && typeof address !== 'string' ? address.port : port;
    console.log(`mock supabase on http://127.0.0.1:${actualPort} (rest/v1/yh_records)`);
  });
}
