// Standalone PostgreSQL WASM regression; reuses an existing PGlite installation.
// node tests/stability-constraints.mjs E:/Temp/yh-stability-sql-20261113-cloud
// No repository dependency changes, HTTP requests, services, or production data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const pgliteRoot = process.argv[2] || process.env.YH_PGLITE_TEST_ROOT;
if (!pgliteRoot) throw new Error('Supply the existing PGlite installation root as argument or YH_PGLITE_TEST_ROOT');
const { PGlite } = await import(pathToFileURL(path.join(path.resolve(pgliteRoot), 'node_modules/@electric-sql/pglite/dist/index.js')).href);
const [prepare, finalize] = await Promise.all([
  readFile(path.join(root, 'supabase/migrations/2026-11-13-stability-prepare.sql'), 'utf8'),
  readFile(path.join(root, 'supabase/migrations/2026-11-13-stability-finalize.sql'), 'utf8'),
]);

const legacy = `
  create table public.yh_records (
    id text not null, record_id text not null, ledger text not null, kind text not null,
    data jsonb not null default '{}', updated_at bigint not null,
    device_id text not null default '', deleted boolean not null default false,
    constraint "legacy custom ""key""" primary key (id)
  );
  insert into public.yh_records(id,record_id,ledger,kind,data,updated_at)
    values ('product:old','old','fixture-a','product','{"name":"historical","nested":[1,true]}',123);
`;

const db = new PGlite();
let passed = 0;
let failed = 0;
const snapshot = async () => ({
  pk: (await db.query(`select c.conname, array(
    select a.attname from unnest(c.conkey) with ordinality k(num,n)
    join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num order by k.n
  ) cols from pg_constraint c where c.conrelid='public.yh_records'::regclass and c.contype='p'`)).rows,
  rows: (await db.query('select * from public.yh_records order by ledger,id')).rows,
  indexes: (await db.query(`select indexrelid::text, indisunique, indisprimary, indkey::text,
    pg_get_indexdef(indexrelid) definition from pg_index
    where indrelid='public.yh_records'::regclass order by indexrelid`)).rows,
});

async function fixture(mode) {
  await db.exec('drop schema public cascade; create schema public; grant usage on schema public to anon;');
  await db.exec(legacy);
  await db.exec(prepare);
  if (mode === 'compound-pk') await db.exec(finalize);
}

async function run(name, test) {
  try {
    await test();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.message}`);
    await db.exec('rollback');
  }
}

const rejectedIndexes = [
  ['single-column id constraint', 'alter table public.yh_records add constraint extra_global unique(id)'],
  ['multicolumn constraint', 'alter table public.yh_records add constraint extra_global unique(id,kind)'],
  ['reordered multicolumn index', 'create unique index extra_global on public.yh_records(kind,id)'],
  ['unrelated direct key', 'create unique index extra_global on public.yh_records(record_id)'],
  ['lower(id) expression', 'create unique index extra_global on public.yh_records(lower(id))'],
  ['id plus expression', 'create unique index extra_global on public.yh_records(id,lower(kind))'],
  ['ledger expression is not a direct key', 'create unique index extra_global on public.yh_records(lower(ledger),id)'],
  ['ledger included but not a key', 'create unique index extra_global on public.yh_records(id) include(ledger)'],
  ['partial global unique', 'create unique index extra_global on public.yh_records(id,kind) where not deleted'],
];
const allowedIndexes = [
  ['nonunique expression', 'create index extra_allowed on public.yh_records(lower(id))'],
  ['ledger direct key', 'create unique index extra_allowed on public.yh_records(kind,ledger,id)'],
  ['ledger plus expression', 'create unique index extra_allowed on public.yh_records(ledger,lower(id))'],
  ['partial ledger direct key', 'create unique index extra_allowed on public.yh_records(ledger,id) where not deleted'],
];
const rejectedExclusions = [
  ['int4range overlap exclusion', `alter table public.yh_records add column period int4range;
    alter table public.yh_records add constraint extra_exclusion exclude using gist (period with &&)`],
];

try {
  await db.exec('create role anon nologin');
  for (const mode of ['legacy-pk', 'compound-pk']) {
    for (const [name, ddl] of rejectedExclusions) {
      await run(`${mode}: rejects ${name} and preserves PK/data/indexes`, async () => {
        await fixture(mode);
        await db.exec(ddl);
        const before = await snapshot();
        let rejection;
        try {
          await db.exec(finalize);
        } catch (error) {
          rejection = error;
          await db.exec('rollback');
        }
        assert.ok(rejection, 'exclusion constraint was accepted');
        assert.match(rejection.message, /SYNC_FINALIZE_EXCLUSION_CONSTRAINT/);
        assert.deepEqual(await snapshot(), before, 'failed migration must preserve every fixture row/index and PK');
      });
    }
    for (const [name, ddl] of rejectedIndexes) {
      await run(`${mode}: rejects ${name} and preserves PK/data/indexes`, async () => {
        await fixture(mode);
        await db.exec(ddl);
        const before = await snapshot();
        let rejection;
        try {
          await db.exec(finalize);
        } catch (error) {
          rejection = error;
          await db.exec('rollback');
        }
        assert.ok(rejection, 'unsafe extra unique index was accepted');
        assert.match(rejection.message, /SYNC_FINALIZE_GLOBAL_ID_UNIQUENESS/);
        assert.deepEqual(await snapshot(), before, 'failed migration must preserve every fixture row/index and PK');
      });
    }
    for (const [name, ddl] of allowedIndexes) {
      await run(`${mode}: allows ${name} and remains idempotent`, async () => {
        await fixture(mode);
        await db.exec(ddl);
        const before = await snapshot();
        await db.exec(finalize);
        await db.exec(finalize);
        const after = await snapshot();
        assert.deepEqual(after.pk, [{ conname: before.pk[0].conname, cols: ['ledger', 'id'] }]);
        assert.deepEqual(after.rows, before.rows);
        assert.ok(after.indexes.some(index => index.definition.includes('extra_allowed')), 'reviewed safe index must remain');
      });
    }
  }
} finally {
  await db.close();
}
console.log(`Targeted constraints complete: ${passed} passed, ${failed} failed; PostgreSQL WASM only, no HTTP/multi-session concurrency claim.`);
process.exitCode = failed ? 1 : 0;
