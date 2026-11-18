// Standalone actual PostgreSQL WASM tests. No HTTP, TCP database, or cloud connection.
// node supabase/tests/reconcile.mjs E:\Temp\yh-stability-sql-20261113-cloud\node_modules\@electric-sql\pglite\dist\index.js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const modulePath = process.argv[2];
if (!modulePath) throw new Error('Pass the absolute installed PGlite module path; this runner never installs dependencies.');
const { PGlite } = await import(pathToFileURL(modulePath).href);
const fixture = JSON.parse(await readFile(new URL('./reconcile.fixture.json', import.meta.url), 'utf8'));
const read = file => readFile(new URL(file, import.meta.url), 'utf8');
const schema = await read('../schema.sql');
const prepare = await read('../migrations/2026-11-13-stability-prepare.sql');
const projectionSql = `select coalesce(jsonb_agg(jsonb_build_object('id',id,'record_id',record_id,'kind',kind,'data',data,
  'updated_at',updated_at,'record_updated_at',record_updated_at,'deleted',deleted) order by id collate "C"),'[]'::jsonb) snapshot
  from public.yh_records where ledger=$1 and not (kind='setting' and record_id in ('deviceId','deviceName','operatorSelf','sync-unknown-kinds'))`;
let passed = 0;
for (const installation of ['schema', 'prepare']) {
  const db = new PGlite();
  try {
    await db.exec('create role anon nologin');
    await db.exec(installation === 'schema' ? schema : prepare);
    // Both installation blocks must be identical and support repeat application.
    await db.exec(installation === 'schema' ? schema : prepare);
    const setLedger = async (ledger = fixture.ledger, epoch = '0') => db.query("select set_config('request.headers',$1,false)",
      [JSON.stringify({ 'x-ledger-key': ledger, ...(epoch === undefined ? {} : { 'x-yh-clear-epoch': epoch }) })]);
    const insert = async row => db.query(`insert into public.yh_records(id,record_id,ledger,kind,data,updated_at,record_updated_at,clear_epoch)
      values($1,$2,$3,$4,$5,$6,$7,$8)`, [row.id, row.record_id, row.ledger ?? fixture.ledger, row.kind, row.data,
      row.updated_at, row.record_updated_at ?? 0, row.clear_epoch ?? 0]);
    const current = async () => (await db.query(projectionSql, [fixture.ledger])).rows[0].snapshot;
    const call = async (operationId, expected = fixture.expectedRows, rows = fixture.rows) =>
      (await db.query('select public.yh_reconcile_push($1::uuid,$2::jsonb,$3::jsonb) receipt', [operationId, expected, rows])).rows[0].receipt;
    const id = suffix => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
    const rejects = async (suffix, expected, rows, pattern) => assert.rejects(call(id(suffix), expected, rows), error => pattern.test(error.message));
    await setLedger();
    for (const row of fixture.expectedRows) await insert(row);
    await insert({ id: 'setting:deviceName', record_id: 'deviceName', kind: 'setting', data: { key: 'deviceName', value: 'local identity' }, updated_at: 30 });
    await setLedger('other-ledger');
    await insert({ id: 'product:other', record_id: 'other', ledger: 'other-ledger', kind: 'product', data: { name: 'B' }, updated_at: 1 });
    await setLedger();
    await db.exec('set role anon');
    assert.deepEqual(await current(), fixture.expectedRows, 'actual exact projection includes marker, excludes only local settings');
    assert.equal((await db.query("select count(*)::int n from public.yh_records where ledger='other-ledger'")).rows[0].n, 0, 'anon RLS hides other ledger');
    await db.query("select set_config('request.headers','{}',false)");
    await rejects(1, fixture.expectedRows, fixture.rows, /SYNC_LEDGER_HEADER_REQUIRED/);
    await setLedger();
    await rejects(2, {}, fixture.rows, /SYNC_RECONNECT_INVALID/);
    await rejects(3, fixture.expectedRows, {}, /SYNC_RECONNECT_INVALID/);
    await rejects(4, fixture.expectedRows, [{ ...fixture.rows[0], ledger: 'other-ledger' }], /SYNC_LEDGER_HEADER_MISMATCH/);
    await rejects(5, fixture.expectedRows, [fixture.rows[0], fixture.rows[0]], /SYNC_RECONNECT_INVALID/);
    await rejects(6, [...fixture.expectedRows, fixture.expectedRows[0]], fixture.rows, /SYNC_RECONNECT_INVALID/);
    await rejects(7, fixture.expectedRows, [{ ...fixture.rows[0], id: 'wrong' }], /SYNC_RECONNECT_INVALID/);
    await rejects(8, fixture.expectedRows, [{ ...fixture.rows[0], kind: 'new-kind', id: 'new-kind:p1' }], /SYNC_RECONNECT_INVALID/);
    await rejects(9, fixture.expectedRows, [{ ...fixture.rows[0], kind: 'ledger', id: '__ledger_cleared__:reconcile-test' }], /SYNC_RECONNECT_INVALID/);
    await rejects(10, fixture.expectedRows, Array(10001).fill(fixture.rows[0]), /SYNC_RECONNECT_INVALID/);
    await rejects(11, Array(10001).fill(fixture.expectedRows[0]), fixture.rows, /SYNC_RECONNECT_INVALID/);
    await db.query("update public.yh_records set data=data || '{\"concurrent\":true}'::jsonb where ledger=$1 and id='product:p1'", [fixture.ledger]);
    const changed = await current();
    await rejects(12, fixture.expectedRows, fixture.rows, /SYNC_RECONNECT_BASELINE_CHANGED/);
    assert.deepEqual(await current(), changed, 'baseline mismatch writes nothing');
    assert.equal((await db.query('select count(*)::int n from public.yh_reconcile_operations')).rows[0].n, 0);
    await db.query('update public.yh_records set data=$1 where ledger=$2 and id=$3', [fixture.expectedRows[1].data, fixture.ledger, 'product:p1']);
    // Any row-level failure must undo already-written rows and leave no successful receipt.
    await db.exec('reset role');
    await db.exec(`create function public.reconcile_test_failure() returns trigger language plpgsql as $$ begin
      if new.id='product:fail' then raise exception 'TEST_RECONCILE_FAILURE'; end if; return new; end; $$;
      create trigger zz_reconcile_test_failure before insert or update on public.yh_records for each row execute function public.reconcile_test_failure()`);
    await db.exec('set role anon');
    await rejects(13, fixture.expectedRows, [fixture.rows[0], { ...fixture.rows[0], id: 'product:fail', record_id: 'fail' }], /TEST_RECONCILE_FAILURE/);
    assert.deepEqual(await current(), fixture.expectedRows, 'entire batch rolled back');
    assert.equal((await db.query('select count(*)::int n from public.yh_reconcile_operations')).rows[0].n, 0, 'receipt rolled back');
    const receipt = await call(id(14));
    assert.deepEqual(receipt, { operationId: id(14), pushedCount: 1 });
    assert.deepEqual((await current()).find(row => row.id === 'product:p1').data, fixture.rows[0].data, 'business data preserved including nested arrays');
    await db.query("update public.yh_records set data='{\"name\":\"newer remote\"}' where ledger=$1 and id='product:p1'", [fixture.ledger]);
    await insert({ id: 'product:later', record_id: 'later', kind: 'product', data: { name: 'later' }, updated_at: 40 });
    const later = await current();
    assert.deepEqual(await call(id(14)), receipt, 'response-loss same operation returns original count');
    assert.deepEqual(await current(), later, 'receipt retry never reapplies stale payload or clears new data');
    assert.deepEqual(await call(id(14), null, null), receipt, 'receipt check precedes even request validation');
    await rejects(15, later.filter(row => row.kind !== 'ledger'), fixture.rows, /SYNC_RECONNECT_BASELINE_CHANGED/);
    await setLedger('other-ledger');
    assert.equal((await db.query('select count(*)::int n from public.yh_reconcile_operations')).rows[0].n, 0, 'receipt RLS hides other ledger');
    await setLedger();
    await assert.rejects(db.exec('delete from public.yh_reconcile_operations'), /permission denied/);
    await assert.rejects(db.query('insert into public.yh_reconcile_operations values ($1,$2,0)', [fixture.ledger, id(20)]), /permission denied/);
    await db.exec('reset role');
    await db.query('insert into public.yh_ledger_state(ledger,clear_epoch) values ($1,7)', [fixture.ledger]);
    await db.exec('set role anon');
    await rejects(16, later, fixture.rows, /SYNC_CLEAR_EPOCH_MISMATCH/);
    await setLedger(fixture.ledger, '7');
    await rejects(17, later, fixture.rows, /SYNC_CLEAR_EPOCH_MISMATCH/);
    await call(id(18), later, fixture.rows.map(row => ({ ...row, clear_epoch: 7 })));
    await setLedger(fixture.ledger, '0');
    assert.deepEqual(await call(id(14)), receipt, 'old receipt remains valid after later epoch change');
    await db.exec('reset role');
    const guard = (await db.query(`select pg_get_functiondef('public.yh_reconcile_push(uuid,jsonb,jsonb)'::regprocedure) definition`)).rows[0].definition;
    assert.match(guard, /SECURITY DEFINER/); assert.match(guard, /search_path TO 'pg_catalog', 'public'/);
    assert.match(guard, /pg_advisory_xact_lock/);
    assert.equal((await db.query("select has_table_privilege('anon','public.yh_reconcile_operations','INSERT,UPDATE,DELETE') allowed")).rows[0].allowed, false);
    assert.equal((await db.query("select count(*)::int n from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where p.oid='public.yh_reconcile_push(uuid,jsonb,jsonb)'::regprocedure and acl.grantee=0 and acl.privilege_type='EXECUTE'")).rows[0].n, 0);
    console.log(`PASS ${installation}: exact projection / marker / validation / anon RLS / atomic rollback / receipt-first idempotency / trigger epoch guard`);
    passed++;
  } finally { await db.close(); }
}
const block = sql => sql.slice(sql.indexOf('-- RECONNECT_RECONCILE_BEGIN'), sql.indexOf('-- RECONNECT_RECONCILE_END'));
assert.ok(block(schema)); assert.equal(block(schema), block(prepare), 'installation blocks identical');
console.log(`GREEN ${passed} standalone PostgreSQL WASM installation suites; no actual HTTP or multi-session concurrency claim.`);
