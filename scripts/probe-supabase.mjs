// 验证 Supabase 项目：表可读、带同步码可写、无/错同步码被 RLS 拒绝。
// 用法（key 只从环境变量读，不落盘）：
//   SUPABASE_URL=... SUPABASE_KEY=... LEDGER=probe-... node scripts/probe-supabase.mjs

const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const key = process.env.SUPABASE_KEY ?? '';
const ledger = process.env.LEDGER ?? 'probe-ledger';
const wrong = 'wrong-ledger';

if (!url || !key) {
  console.error('缺少 SUPABASE_URL / SUPABASE_KEY');
  process.exit(1);
}

const headers = (l) => ({
  apikey: key,
  ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
  'Content-Type': 'application/json',
  'x-ledger-key': l
});

async function call(label, method, path, body, l = ledger) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      ...headers(l),
      ...(method === 'POST' ? { Prefer: 'resolution=merge-duplicates,return=representation' } : {}),
      ...(method === 'DELETE' ? { Prefer: 'return=minimal' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  console.log(`${label}: HTTP ${res.status}${text ? ' ' + text.slice(0, 160) : ''}`);
  return { status: res.status, text };
}

const rowId = `probe:${Date.now()}`;
const row = {
  id: rowId,
  record_id: String(Date.now()),
  ledger,
  kind: 'setting',
  data: { key: 'probe', value: '1' },
  updated_at: Date.now(),
  device_id: 'probe',
  deleted: false
};

let ok = true;

const read1 = await call('1 读表', 'GET', 'yh_records?select=id&limit=1');
if (![200, 206].includes(read1.status)) ok = false;

const write = await call('2 写入', 'POST', 'yh_records?on_conflict=id', row);
if (![200, 201].includes(write.status)) ok = false;

const read2 = await call(
  '3 读回自己的账本',
  'GET',
  `yh_records?ledger=eq.${encodeURIComponent(ledger)}&select=id&limit=5`
);
if (!read2.text.includes(rowId)) ok = false;

const readWrong = await call(
  '4 用错同步码读',
  'GET',
  `yh_records?ledger=eq.${encodeURIComponent(ledger)}&select=id&limit=5`,
  undefined,
  wrong
);
if (readWrong.text.includes(rowId)) ok = false;

const writeWrong = await call(
  '5 用错同步码写',
  'POST',
  'yh_records?on_conflict=id',
  { ...row, id: `${rowId}:wrong` },
  wrong
);
if ([200, 201].includes(writeWrong.status) && writeWrong.text.includes('wrong')) ok = false;

await call('6 清理测试行', 'DELETE', `yh_records?id=eq.${encodeURIComponent(rowId)}`);
await call('7 清理错误行', 'DELETE', `yh_records?id=eq.${encodeURIComponent(rowId + ':wrong')}`);

console.log(ok ? '\nOK：表可读写，且错误同步码被拒绝' : '\nFAIL：策略或表有问题，看上面状态码');
process.exit(ok ? 0 : 1);