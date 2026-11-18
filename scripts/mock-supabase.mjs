// 本地假 Supabase（只实现同步用到的 REST 子集），用来验证自动同步。
// 运行：node scripts/mock-supabase.mjs [port]

import http from 'node:http';
import { pathToFileURL } from 'node:url';

const TABLE_PATH = '/rest/v1/yh_records';
const CAPABILITIES_PATH = '/rest/v1/rpc/yh_sync_capabilities';
const CLEAR_PATH = '/rest/v1/rpc/yh_clear_ledger';
const EPOCH_HEADER = 'x-yh-clear-epoch';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILTER_KEYS = new Set(['ledger', 'id', 'record_id', 'kind', 'or', 'updated_at', 'order', 'limit', 'select']);
const COLUMNS = new Set(['id', 'record_id', 'ledger', 'kind', 'data', 'updated_at', 'record_updated_at', 'schema_version', 'device_id', 'deleted']);
const V2_COLUMNS = new Set([...COLUMNS, 'clear_epoch']);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', `apikey, authorization, content-type, prefer, x-ledger-key, ${EPOCH_HEADER}`);
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

function parseInValues(raw) {
  if (!raw.startsWith('in.(') || !raw.endsWith(')')) return null;
  const body = raw.slice(4, -1);
  const values = [];
  let offset = 0;
  while (offset < body.length) {
    while (/\s/.test(body[offset] ?? '') && offset < body.length) offset++;
    let value = '';
    if (body[offset] === '"') {
      offset++;
      let closed = false;
      while (offset < body.length) {
        const char = body[offset++];
        if (char === '"') { closed = true; break; }
        if (char === '\\') {
          if (offset === body.length) return null;
          const escaped = body[offset++];
          if (escaped !== '"' && escaped !== '\\') return null;
          value += escaped;
        } else value += char;
      }
      if (!closed) return null;
      while (/\s/.test(body[offset] ?? '') && offset < body.length) offset++;
      if (offset < body.length && body[offset] !== ',') return null;
    } else {
      const start = offset;
      while (offset < body.length && body[offset] !== ',') offset++;
      value = body.slice(start, offset).trim();
      if (/[()"\\]/.test(value)) return null;
    }
    if (!value) return null;
    values.push(value);
    if (offset < body.length) {
      offset++;
      if (offset === body.length) return null;
    }
  }
  return values.length ? values : null;
}

function queryPredicate(url, allowedKeys = FILTER_KEYS) {
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key)) return { error: `unsupported filter: ${key}` };
  }
  const filters = [];
  for (const key of ['ledger', 'id', 'record_id', 'kind']) {
    const raw = url.searchParams.get(key);
    if (raw === null) continue;
    const values = key === 'record_id' && raw.startsWith('in.') ? parseInValues(raw) : null;
    if (raw.startsWith('in.') && !values) return { error: `unsupported ${key} in filter` };
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

function projectRows(rows, url, columnsAllowed) {
  const select = url.searchParams.get('select');
  if (!select || select === '*') return rows;
  const columns = select.split(',').map((column) => column.trim());
  if (columns.some((column) => !columnsAllowed.has(column))) return null;
  return rows.map((row) => Object.fromEntries(columns.filter((column) => column in row).map((column) => [column, row[column]])));
}

function normalizeResult(result) {
  if (result === false) return { status: 503, body: { error: 'injected failure' } };
  if (typeof result === 'number') return { status: result, body: { error: 'injected failure' } };
  if (result && typeof result === 'object' && Number.isInteger(result.status)) return result;
  return null;
}

function matchesEpoch(items, header, currentEpoch) {
  if (header !== undefined && (typeof header !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(header) || header !== String(currentEpoch))) return false;
  if (currentEpoch > 0 && header === undefined) return false;
  return items.every((item) => (item.clear_epoch === undefined && currentEpoch === 0) || item.clear_epoch === currentEpoch);
}

function epochMismatch(res) {
  return response(res, 409, { code: 'SYNC_CLEAR_EPOCH_MISMATCH', message: 'SYNC_CLEAR_EPOCH_MISMATCH' });
}

export function createMockServer(options = {}) {
  const mode = options.mode ?? 'v1';
  if (!['v1', 'v2'].includes(mode)) throw new TypeError(`unsupported mock mode: ${mode}`);
  let rows = new Map();
  let stateEpochs = new Map();
  let receipts = new Map();
  const keyOf = (row) => mode === 'v1' ? String(row.id) : `${row.ledger}\0${row.id}`;
  const epochOf = (ledger) => stateEpochs.get(ledger) ?? 0;

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
    try {
      await options.onRequest?.(request);
      await options.beforeRequest?.(request);
      const injected = normalizeResult(await options.failRequest?.(request));
      if (injected) return response(res, injected.status, injected.body);
    } catch (error) {
      return response(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }

    if (url.pathname === CAPABILITIES_PATH || url.pathname === CLEAR_PATH) {
      if (mode === 'v1') return response(res, 404, { code: 'PGRST202' });
      if (!ledger) return response(res, 403, { error: 'ledger header required' });
      if (url.searchParams.size) return response(res, 400, { error: 'RPC query parameters are unsupported' });
      if (url.pathname === CAPABILITIES_PATH) {
        if (!['GET', 'POST'].includes(req.method)) return response(res, 405, { error: 'method' });
        return response(res, 200, {
          protocolVersion: 2, conflictTarget: 'ledger,id', ledgerScoped: true, clearRpcEnabled: true,
          clearEpoch: epochOf(ledger), epochHeader: EPOCH_HEADER, epochHeaderRequired: epochOf(ledger) > 0
        });
      }
      if (req.method !== 'POST') return response(res, 405, { error: 'method' });
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return response(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.p_operation_id !== 'string' || !UUID.test(payload.p_operation_id)) {
        return response(res, 400, { code: '22023', message: 'SYNC_CLEAR_OPERATION_ID_REQUIRED' });
      }
      const operationId = payload.p_operation_id.toLowerCase();
      const receiptKey = `${ledger}\0${operationId}`;
      if (receipts.has(receiptKey)) return response(res, 200, receipts.get(receiptKey));

      const clearedAt = Date.now();
      const clearEpoch = Math.max(clearedAt, epochOf(ledger) + 1);
      let clearedCount = 0;
      const stagedRows = new Map(rows);
      for (const [key, row] of rows) {
        if (row.ledger !== ledger) continue;
        if (row.kind !== 'ledger' && !row.deleted) clearedCount++;
        stagedRows.set(key, { ...row, deleted: true, updated_at: clearedAt, record_updated_at: clearedAt, clear_epoch: clearEpoch });
      }
      const markerId = `__ledger_cleared__:${ledger}`;
      const marker = {
        id: markerId, record_id: markerId, ledger, kind: 'ledger', data: { clearedAt, clearEpoch },
        updated_at: clearedAt, record_updated_at: clearedAt, schema_version: 2, clear_epoch: clearEpoch, device_id: '', deleted: false
      };
      stagedRows.set(keyOf(marker), marker);
      const receipt = { operationId, clearedAt, clearedCount, clearEpoch };
      const stagedEpochs = new Map(stateEpochs).set(ledger, clearEpoch);
      const stagedReceipts = new Map(receipts).set(receiptKey, receipt);
      // No awaits after staging: rows, marker, epoch and receipt become visible together.
      rows = stagedRows;
      stateEpochs = stagedEpochs;
      receipts = stagedReceipts;
      return response(res, 200, receipt);
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
      const projected = projectRows(ordered.slice(0, Number(limitRaw)), url, mode === 'v2' ? V2_COLUMNS : COLUMNS);
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
      if (mode === 'v2' && !matchesEpoch(items, req.headers[EPOCH_HEADER], epochOf(ledger))) return epochMismatch(res);
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
    if (mode === 'v2' && !matchesEpoch([patch], req.headers[EPOCH_HEADER], epochOf(ledger))) return epochMismatch(res);
    const staged = new Map();
    for (const [key, row] of rows) {
      if (row.ledger !== ledger || !predicate.test(row)) continue;
      const next = { ...row, ...patch };
      staged.set(key, next);
    }
    for (const [key, row] of staged) rows.set(key, row);
    return response(res, 204);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 54321);
  const server = createMockServer({ mode: process.env.MOCK_SCHEMA_MODE || 'v1' });
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const actualPort = address && typeof address !== 'string' ? address.port : port;
    console.log(`mock supabase on http://127.0.0.1:${actualPort} (rest/v1/yh_records)`);
  });
}
