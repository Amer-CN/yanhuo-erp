-- 仅独立本地测试数据库；运行者需能 SET ROLE anon、临时创建测试触发器。
-- 由 psql 使用 ON_ERROR_STOP=1 执行；PGlite harness 单独验证入口 SQL，再执行验收事务。
-- 先应用 prepare + finalize（新库也可应用 schema.sql）。所有测试更改最终 ROLLBACK。
-- SQL/RLS 验证不等于真实 PostgREST HTTP 或多连接并发验证。
-- psql 入口要求 YH_TEST_DATABASE_URL=loopback，并显式传入预期数据库名：
-- psql "$YH_TEST_DATABASE_URL" -v yh_test_database_name=yh_stability_test -f supabase/tests/stability.sql
-- 测试库须由维护者预先专门标记（本脚本绝不自动标记数据库）：
-- ALTER DATABASE yh_stability_test SET yh.protocol_test_database='stability-2026-11-13';
-- 标记从 pg_db_role_setting 的数据库级配置读取，临时 SET 自定义 GUC 不能伪造。
\set ON_ERROR_STOP on
\if :{?yh_test_database_name}
\else
\echo 'FAIL: pass -v yh_test_database_name=<dedicated test database>'
\quit 2
\endif
\getenv yh_test_database_url YH_TEST_DATABASE_URL
\if :{?yh_test_database_url}
\else
\echo 'FAIL: YH_TEST_DATABASE_URL is required (isolated loopback test DB)'
\quit 2
\endif
select :'yh_test_database_url' ~ '^postgres(ql)?://([^/@?#]*@)?(localhost|127[.]0[.]0[.]1|\[::1\])(:[0-9]+)?/[^/?#]+([?][^#]*)?$'
  and :'yh_test_database_url' !~* '[?&](host|hostaddr|service|port)='
  as yh_test_loopback \gset
\if :yh_test_loopback
\else
\echo 'FAIL: YH_TEST_DATABASE_URL must name an isolated loopback PostgreSQL database'
\quit 2
\endif
select coalesce(pg_catalog.inet_server_addr() <<= '127.0.0.0/8'::inet
  or pg_catalog.inet_server_addr()='::1'::inet,false) as yh_test_local_server \gset
\if :yh_test_local_server
\else
\echo 'FAIL: connected PostgreSQL server is not loopback'
\quit 2
\endif
-- ENTRY_DATABASE_GUARD_BEGIN：在任何业务 fixture 写入前验证实际连接身份和专用库标记。
-- 仅接受不需 URI 解码的简单数据库名，拒绝编码/额外路径带来的 URL 与 -v 歧义。
select pg_catalog.set_config('yh.test.expected_database', :'yh_test_database_name', false);
select pg_catalog.set_config('yh.test.database_url', :'yh_test_database_url', false);
do $$
declare
  v_expected text := pg_catalog.current_setting('yh.test.expected_database');
  v_url text := pg_catalog.current_setting('yh.test.database_url');
  v_url_database text;
begin
  v_url_database := substring(v_url from '^postgres(?:ql)?://[^/]+/([^/?#]+)');
  if v_expected !~ '^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$'
    or v_url_database is distinct from v_expected
    or pg_catalog.current_database()::text is distinct from v_expected then
    raise exception 'SYNC_TEST_DATABASE_NAME_MISMATCH: URL, -v yh_test_database_name and current_database() must match';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_db_role_setting s
    join pg_catalog.pg_database d on d.oid=s.setdatabase
    where d.datname=pg_catalog.current_database() and s.setrole=0
      and 'yh.protocol_test_database=stability-2026-11-13'=any(s.setconfig)
  ) then
    raise exception 'SYNC_TEST_DATABASE_MARKER_REQUIRED: database must be explicitly designated for protocol tests';
  end if;
end;
$$;
-- ENTRY_DATABASE_GUARD_END
begin;

create function pg_temp.yh_assert(ok boolean, message text)
returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'ASSERTION FAILED: %', message; end if;
end;
$$;

select pg_catalog.set_config('yh.test.prefix', 'yh-sql-' || pg_catalog.gen_random_uuid()::text, true);
select pg_catalog.set_config('yh.test.ledger_a', pg_catalog.current_setting('yh.test.prefix') || '-a', true);
select pg_catalog.set_config('yh.test.ledger_b', pg_catalog.current_setting('yh.test.prefix') || '-b', true);
select pg_catalog.set_config('yh.test.ledger_fail', pg_catalog.current_setting('yh.test.prefix') || '-fail', true);
select pg_catalog.set_config('request.headers', pg_catalog.json_build_object('x-ledger-key', pg_catalog.current_setting('yh.test.ledger_a'))::text, true);

set local role anon;
select pg_temp.yh_assert((public.yh_sync_capabilities()->>'protocolVersion')::int = 2, 'protocol v2');
select pg_temp.yh_assert(public.yh_sync_capabilities()->>'conflictTarget' = 'ledger,id', 'compound conflict target');
select pg_temp.yh_assert((public.yh_sync_capabilities()->>'ledgerScoped')::boolean, 'actual compound primary key');
select pg_temp.yh_assert((public.yh_sync_capabilities()->>'clearRpcEnabled')::boolean, 'finalize enables clear');
select pg_temp.yh_assert((public.yh_sync_capabilities()->>'clearEpoch')::bigint = 0, 'uncleared ledger starts at epoch zero');
select pg_temp.yh_assert(public.yh_sync_capabilities()->>'epochHeader' = 'x-yh-clear-epoch', 'capability advertises required epoch header');
select pg_temp.yh_assert(not (public.yh_sync_capabilities()->>'epochHeaderRequired')::boolean, 'epoch zero allows header-less old client');

-- 两个账本同 id 合法，同账本 upsert 不重复；每个断言均以 anon/RLS 执行。
insert into public.yh_records (id,record_id,ledger,kind,data,updated_at)
values ('product:shared','shared',pg_catalog.current_setting('yh.test.ledger_a'),'product','{"name":"A"}',1)
on conflict (ledger,id) do update set data = excluded.data;
select pg_catalog.set_config('request.headers', pg_catalog.json_build_object('x-ledger-key', pg_catalog.current_setting('yh.test.ledger_b'))::text, true);
insert into public.yh_records (id,record_id,ledger,kind,data,updated_at)
values ('product:shared','shared',pg_catalog.current_setting('yh.test.ledger_b'),'product','{"name":"B"}',1)
on conflict (ledger,id) do update set data = excluded.data;
select pg_temp.yh_assert((select count(*) from public.yh_records) = 1, 'B sees only B');
select pg_temp.yh_assert((select data->>'name' from public.yh_records where id='product:shared') = 'B', 'B retains own shared id');
select pg_temp.yh_assert((select count(*) from public.yh_records where ledger=pg_catalog.current_setting('yh.test.ledger_a')) = 0, 'RLS hides other ledger');
update public.yh_records set data='{"name":"illegal"}' where ledger=pg_catalog.current_setting('yh.test.ledger_a');

do $$
begin
  begin
    insert into public.yh_records (id,record_id,ledger,kind,updated_at)
    values ('product:cross','cross',pg_catalog.current_setting('yh.test.ledger_a'),'product',1);
    raise exception 'ASSERTION FAILED: cross-ledger insert accepted';
  exception when insufficient_privilege then null; end;
  begin
    update public.yh_records set ledger=pg_catalog.current_setting('yh.test.ledger_a') where id='product:shared';
    raise exception 'ASSERTION FAILED: cross-ledger move accepted';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.yh_records;
    raise exception 'ASSERTION FAILED: DELETE accepted';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.yh_ledger_state(ledger,clear_epoch) values (pg_catalog.current_setting('yh.test.ledger_b'),999);
    raise exception 'ASSERTION FAILED: direct state mutation accepted';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.yh_clear_operations(ledger,operation_id,cleared_at,cleared_count,clear_epoch)
    values (pg_catalog.current_setting('yh.test.ledger_b'),pg_catalog.gen_random_uuid(),1,0,0);
    raise exception 'ASSERTION FAILED: forged receipt accepted';
  exception when insufficient_privilege then null; end;
end;
$$;

-- 空、缺失、空白、非字符串 header 均拒绝；空头读不到任何行。
select pg_catalog.set_config('request.headers', '{}', true);
do $$
begin
  begin
    perform public.yh_sync_capabilities();
    raise exception 'ASSERTION FAILED: missing header capability accepted';
  exception when insufficient_privilege then
    perform pg_temp.yh_assert(sqlerrm like '%SYNC_LEDGER_HEADER_REQUIRED%', 'explicit header diagnostic');
  end;
  begin
    perform public.yh_clear_ledger('00000000-0000-4000-8000-000000000001');
    raise exception 'ASSERTION FAILED: missing header clear accepted';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.yh_records(id,record_id,ledger,kind,updated_at) values ('empty','empty','','product',1);
    raise exception 'ASSERTION FAILED: empty ledger write accepted';
  exception when insufficient_privilege then null; end;
end;
$$;
do $$
begin
  begin
    perform count(*) from public.yh_records;
    raise exception 'ASSERTION FAILED: missing header read accepted';
  exception when insufficient_privilege then null; end;
end;
$$;
select pg_catalog.set_config('request.headers', '{"x-ledger-key":"   "}', true);
do $$
begin
  begin
    perform public.yh_sync_capabilities();
    raise exception 'ASSERTION FAILED: whitespace header accepted';
  exception when insufficient_privilege then null; end;
end;
$$;
select pg_catalog.set_config('request.headers', '{"x-ledger-key":123}', true);
do $$
begin
  begin
    perform public.yh_sync_capabilities();
    raise exception 'ASSERTION FAILED: numeric header accepted';
  exception when insufficient_privilege then null; end;
end;
$$;

-- 一个事务清账：墓碑、新 epoch、marker 和不可伪造凭证共同提交。
select pg_catalog.set_config('request.headers', pg_catalog.json_build_object('x-ledger-key', pg_catalog.current_setting('yh.test.ledger_a'))::text, true);
select pg_catalog.set_config('yh.test.receipt', public.yh_clear_ledger('00000000-0000-4000-8000-000000000002')::text, true);
select pg_temp.yh_assert((pg_catalog.current_setting('yh.test.receipt')::jsonb->>'clearedCount')::bigint = 1, 'clear count excludes marker');
select pg_temp.yh_assert(pg_catalog.current_setting('yh.test.receipt')::jsonb->>'operationId' = '00000000-0000-4000-8000-000000000002', 'receipt operation identity');
select pg_temp.yh_assert((pg_catalog.current_setting('yh.test.receipt')::jsonb->>'clearEpoch')::bigint > 0, 'clear advances server epoch');
select pg_temp.yh_assert((select deleted from public.yh_records where id='product:shared'), 'old business row tombstoned');
select pg_temp.yh_assert((select clear_epoch from public.yh_records where id='product:shared') = (pg_catalog.current_setting('yh.test.receipt')::jsonb->>'clearEpoch')::bigint, 'tombstone carries new epoch');
select pg_temp.yh_assert((select count(*) from public.yh_records where kind='ledger' and not deleted and data->>'clearEpoch'=pg_catalog.current_setting('yh.test.receipt')::jsonb->>'clearEpoch') = 1, 'live marker carries epoch');
select pg_temp.yh_assert((select count(*) from public.yh_clear_operations) = 1, 'own receipt readable');
select pg_temp.yh_assert(pg_catalog.current_setting('request.headers')::jsonb = pg_catalog.jsonb_build_object('x-ledger-key',pg_catalog.current_setting('yh.test.ledger_a')), 'clear restores original request headers');
select pg_temp.yh_assert((public.yh_sync_capabilities()->>'epochHeaderRequired')::boolean, 'cleared ledger requires request epoch header');

do $$
begin
  begin
    insert into public.yh_records(id,record_id,ledger,kind,updated_at)
    values ('product:stale','stale',pg_catalog.current_setting('yh.test.ledger_a'),'product',2);
    raise exception 'ASSERTION FAILED: epoch-less old client accepted after clear';
  exception when sqlstate 'P0001' then
    perform pg_temp.yh_assert(sqlerrm like '%SYNC_CLEAR_EPOCH_MISMATCH%', 'explicit stale insert error');
  end;
  begin
    update public.yh_records set deleted=false where id='product:shared';
    raise exception 'ASSERTION FAILED: old PATCH inherited new epoch without header';
  exception when sqlstate 'P0001' then
    perform pg_temp.yh_assert(sqlerrm like '%SYNC_CLEAR_EPOCH_MISMATCH%', 'explicit epoch-less PATCH error');
  end;
  begin
    update public.yh_records set deleted=false,clear_epoch=0 where id='product:shared';
    raise exception 'ASSERTION FAILED: stale update accepted after clear';
  exception when sqlstate 'P0001' then
    perform pg_temp.yh_assert(sqlerrm like '%SYNC_CLEAR_EPOCH_MISMATCH%', 'explicit stale update error');
  end;
  begin
    perform public.yh_clear_ledger(null);
    raise exception 'ASSERTION FAILED: null operation accepted';
  exception when invalid_parameter_value then null; end;
end;
$$;
-- 非法/旧 epoch 头即使行继承新 epoch 也不得被接受。
do $$
declare v_header text;
begin
  foreach v_header in array array['0','-1','01','1.0',' 1','99999999999999999999999999999999999'] loop
    perform pg_catalog.set_config('request.headers',pg_catalog.jsonb_build_object(
      'x-ledger-key',pg_catalog.current_setting('yh.test.ledger_a'),'x-yh-clear-epoch',v_header)::text,true);
    begin
      update public.yh_records set deleted=false where id='product:shared';
      raise exception 'ASSERTION FAILED: invalid/old epoch header accepted';
    exception when sqlstate 'P0001' then
      perform pg_temp.yh_assert(sqlerrm like '%SYNC_CLEAR_EPOCH_MISMATCH%', 'invalid request epoch refused');
    end;
  end loop;
end;
$$;
select pg_catalog.set_config('request.headers',pg_catalog.jsonb_build_object(
  'x-ledger-key',pg_catalog.current_setting('yh.test.ledger_a'),
  'x-yh-clear-epoch',pg_catalog.current_setting('yh.test.receipt')::jsonb->>'clearEpoch')::text,true);
do $$
begin
  begin
    update public.yh_records set clear_epoch=0 where id='product:shared';
    raise exception 'ASSERTION FAILED: valid header with stale row epoch accepted';
  exception when sqlstate 'P0001' then
    perform pg_temp.yh_assert(sqlerrm like '%SYNC_CLEAR_EPOCH_MISMATCH%', 'row epoch independently checked');
  end;
end;
$$;
insert into public.yh_records(id,record_id,ledger,kind,data,updated_at,clear_epoch)
values ('product:new','new',pg_catalog.current_setting('yh.test.ledger_a'),'product','{"name":"after-clear"}',3,(pg_catalog.current_setting('yh.test.receipt')::jsonb->>'clearEpoch')::bigint);
select pg_temp.yh_assert(public.yh_clear_ledger('00000000-0000-4000-8000-000000000002') = pg_catalog.current_setting('yh.test.receipt')::jsonb, 'same operation returns identical first receipt');
select pg_temp.yh_assert((select not deleted from public.yh_records where id='product:new'), 'same operation retry leaves new order live');
select pg_catalog.set_config('yh.test.second_receipt', public.yh_clear_ledger('00000000-0000-4000-8000-000000000003')::text, true);
select pg_temp.yh_assert((pg_catalog.current_setting('yh.test.second_receipt')::jsonb->>'clearEpoch')::bigint > (pg_catalog.current_setting('yh.test.receipt')::jsonb->>'clearEpoch')::bigint, 'second operation strictly advances epoch');
select pg_temp.yh_assert(public.yh_clear_ledger('00000000-0000-4000-8000-000000000002') = pg_catalog.current_setting('yh.test.receipt')::jsonb, 'old operation still returns old receipt after later clear');
select pg_catalog.set_config('request.headers', pg_catalog.json_build_object('x-ledger-key', pg_catalog.current_setting('yh.test.ledger_b'))::text, true);
select pg_temp.yh_assert((select not deleted and data->>'name'='B' from public.yh_records where id='product:shared'), 'clear A never alters B');
select pg_temp.yh_assert((select count(*) from public.yh_clear_operations) = 0, 'receipt RLS hides A from B');
select pg_temp.yh_assert((public.yh_sync_capabilities()->>'clearEpoch')::bigint = 0, 'clear A never changes B epoch');

-- 故意让 marker INSERT 失败：epoch、业务墓碑、receipt 必须同时回滚。
reset role;
create function pg_temp.yh_fail_marker() returns trigger language plpgsql as $$
begin
  if new.ledger = pg_catalog.current_setting('yh.test.ledger_fail') and new.kind = 'ledger' then
    raise exception 'TEST_MARKER_FAILURE';
  end if;
  return new;
end;
$$;
create trigger zz_yh_test_marker_failure before insert or update on public.yh_records
for each row execute function pg_temp.yh_fail_marker();
set local role anon;
select pg_catalog.set_config('request.headers', pg_catalog.json_build_object('x-ledger-key', pg_catalog.current_setting('yh.test.ledger_fail'))::text, true);
insert into public.yh_records(id,record_id,ledger,kind,updated_at)
values ('product:rollback','rollback',pg_catalog.current_setting('yh.test.ledger_fail'),'product',1);
do $$
begin
  begin
    perform public.yh_clear_ledger('00000000-0000-4000-8000-000000000004');
    raise exception 'ASSERTION FAILED: marker fault did not abort';
  exception when sqlstate 'P0001' then
    perform pg_temp.yh_assert(sqlerrm = 'TEST_MARKER_FAILURE', 'failure reached marker');
  end;
end;
$$;
select pg_temp.yh_assert((select not deleted and clear_epoch=0 from public.yh_records where id='product:rollback'), 'marker failure rolls back business mutation');
select pg_temp.yh_assert((public.yh_sync_capabilities()->>'clearEpoch')::bigint = 0, 'marker failure rolls back epoch');
select pg_temp.yh_assert((select count(*) from public.yh_clear_operations) = 0, 'marker failure writes no receipt');
select pg_temp.yh_assert(pg_catalog.current_setting('request.headers')::jsonb = pg_catalog.jsonb_build_object('x-ledger-key',pg_catalog.current_setting('yh.test.ledger_fail')), 'marker exception restores original request headers');
reset role;

-- ACL 与 RLS 本身的元数据验收（避免 owner bypass 造成假绿）。
select pg_temp.yh_assert(not pg_catalog.has_table_privilege('anon','public.yh_records','DELETE'), 'anon has no DELETE grant');
select pg_temp.yh_assert(not pg_catalog.has_table_privilege('anon','public.yh_ledger_state','INSERT,UPDATE,DELETE'), 'anon cannot mutate state');
select pg_temp.yh_assert(not pg_catalog.has_table_privilege('anon','public.yh_clear_operations','INSERT,UPDATE,DELETE'), 'anon cannot mutate receipts');
select pg_temp.yh_assert((select relrowsecurity from pg_catalog.pg_class where oid='public.yh_records'::regclass), 'records RLS enabled');
select pg_temp.yh_assert((select relrowsecurity from pg_catalog.pg_class where oid='public.yh_clear_operations'::regclass), 'receipts RLS enabled');
select pg_temp.yh_assert((select relrowsecurity from pg_catalog.pg_class where oid='public.yh_ledger_state'::regclass), 'state RLS enabled');
select pg_temp.yh_assert(not exists (
  select 1 from pg_catalog.pg_proc p, lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
  where p.oid in ('public.yh_sync_capabilities()'::regprocedure,'public.yh_clear_ledger(uuid)'::regprocedure)
    and acl.grantee=0 and acl.privilege_type='EXECUTE'
), 'PUBLIC cannot execute protocol RPCs');
select 'PASS: anon/RLS/compound keys/epoch/idempotency/marker rollback/ACL; all test data rolled back' as result;
rollback;
