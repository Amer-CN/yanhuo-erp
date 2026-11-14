-- B07 准备阶段 / B06 事务清云协议；交付人工迁移包，本地修复不执行生产 SQL。
-- 先备份，再由维护者在独立测试库验证。旧库依次 prepare → 兼容前端 → 两端确认升级 → finalize。
-- 本阶段保留旧 id 主键；只有实际主键已为 (ledger,id) 才启用清云。重复运行不会倒退已完成的库。
-- 新空库也可执行此文件（先建立兼容旧主键），或使用 schema.sql 直接建最终结构。
begin;

create table if not exists public.yh_records (
  id text primary key,
  record_id text not null,
  ledger text not null,
  kind text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at bigint not null,
  record_updated_at bigint not null default 0,
  schema_version int not null default 1,
  clear_epoch bigint not null default 0,
  device_id text not null default '',
  deleted boolean not null default false
);

-- CREATE TABLE IF NOT EXISTS 不会升级旧列；必须显式 ALTER。
alter table public.yh_records add column if not exists record_updated_at bigint not null default 0;
alter table public.yh_records add column if not exists schema_version int not null default 1;
alter table public.yh_records add column if not exists clear_epoch bigint not null default 0;

-- IF NOT EXISTS 仍需核对同名索引的实际列、唯一性及有效状态，防止半迁移或名称碰撞误报能力。
create unique index if not exists yh_records_ledger_id_uq on public.yh_records (ledger,id);
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_index i
    where i.indexrelid = 'public.yh_records_ledger_id_uq'::regclass
      and i.indrelid = 'public.yh_records'::regclass
      and i.indisunique and i.indisvalid and i.indisready
      and i.indpred is null and i.indexprs is null and i.indnkeyatts=2 and i.indnatts=2
      and (select pg_catalog.array_agg(a.attname::text order by k.ordinality)
           from pg_catalog.unnest(i.indkey) with ordinality k(attnum,ordinality)
           join pg_catalog.pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
           where k.ordinality<=i.indnkeyatts) = array['ledger','id']::text[]
  ) then
    raise exception 'SYNC_PREPARE_INVALID_LEDGER_ID_INDEX';
  end if;
end;
$$;
create index if not exists yh_records_ledger_updated_id on public.yh_records (ledger,updated_at,id);
create index if not exists yh_records_ledger_record_updated on public.yh_records (ledger,record_updated_at);

create table if not exists public.yh_ledger_state (
  ledger text primary key,
  clear_epoch bigint not null default 0 check (clear_epoch >= 0)
);
create table if not exists public.yh_clear_operations (
  ledger text not null,
  operation_id uuid not null,
  cleared_at bigint not null,
  cleared_count bigint not null check (cleared_count >= 0),
  clear_epoch bigint not null check (clear_epoch >= 0),
  primary key (ledger,operation_id)
);

-- 返回值只来自请求头；不接受调用者传入任意 ledger。缺失/空白/非字符串一律 fail closed。
create or replace function public.yh_request_ledger()
returns text language plpgsql stable security invoker
set search_path = pg_catalog, public as $$
declare
  v_headers jsonb;
  v_ledger text;
begin
  begin
    v_headers := coalesce(nullif(pg_catalog.current_setting('request.headers',true),''),'{}')::jsonb;
  exception when invalid_text_representation then
    raise exception using errcode='42501', message='SYNC_LEDGER_HEADER_REQUIRED';
  end;
  if pg_catalog.jsonb_typeof(v_headers->'x-ledger-key') is distinct from 'string' then
    raise exception using errcode='42501', message='SYNC_LEDGER_HEADER_REQUIRED';
  end if;
  v_ledger := v_headers->>'x-ledger-key';
  if v_ledger is null or pg_catalog.btrim(v_ledger)='' then
    raise exception using errcode='42501', message='SYNC_LEDGER_HEADER_REQUIRED';
  end if;
  return v_ledger;
end;
$$;
revoke all on function public.yh_request_ledger() from public;
grant execute on function public.yh_request_ledger() to anon;

-- 先在语句级取得账本锁，再让 UPDATE/UPSERT 获取行锁；避免和 clear 的账本锁→行锁次序相反。
create or replace function public.yh_records_lock_ledger()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(public.yh_request_ledger(),0));
  return null;
end;
$$;
revoke all on function public.yh_records_lock_ledger() from public;
drop trigger if exists yh_records_lock_ledger on public.yh_records;
create trigger yh_records_lock_ledger before insert or update on public.yh_records
for each statement execute function public.yh_records_lock_ledger();

-- 业务写与清空共用同一 ledger 事务锁，取得锁后才读取 state。锁一直保持到提交/回滚。
-- 受限 definer 只读取 state；NEW.ledger 必须等于 header，UPDATE 不允许挪动 ledger。
create or replace function public.yh_records_guard_epoch()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_ledger text;
  v_epoch bigint;
  v_request_epoch jsonb;
begin
  v_ledger := public.yh_request_ledger();
  if new.ledger is distinct from v_ledger then
    raise exception using errcode='42501', message='SYNC_LEDGER_HEADER_MISMATCH';
  end if;
  if tg_op='UPDATE' and old.ledger is distinct from new.ledger then
    raise exception using errcode='42501', message='SYNC_LEDGER_HEADER_MISMATCH';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_ledger,0));
  select s.clear_epoch into v_epoch from public.yh_ledger_state s where s.ledger=v_ledger;
  v_epoch := coalesce(v_epoch,0);
  -- PATCH 未显式写列会继承旧行值，不能只校验 NEW；请求头证明客户端已观察当前代。
  -- 未清空账本(epoch=0)允许缺头兼容旧端；一旦清空，缺头/非法头/旧头全部拒绝。
  v_request_epoch := nullif(pg_catalog.current_setting('request.headers',true),'')::jsonb->'x-yh-clear-epoch';
  if v_request_epoch is null and v_epoch=0 then
    null;
  elsif pg_catalog.jsonb_typeof(v_request_epoch) is distinct from 'string'
    or (v_request_epoch #>> '{}') !~ '^(0|[1-9][0-9]{0,18})$'
    or (v_request_epoch #>> '{}') is distinct from v_epoch::text then
    raise exception using errcode='P0001', message='SYNC_CLEAR_EPOCH_MISMATCH',
      detail='Send the current x-yh-clear-epoch header and matching clear_epoch field.';
  end if;
  if new.clear_epoch is distinct from v_epoch then
    raise exception using errcode='P0001', message='SYNC_CLEAR_EPOCH_MISMATCH',
      detail='Fetch yh_sync_capabilities and reconcile pending data before writing.';
  end if;
  return new;
end;
$$;
revoke all on function public.yh_records_guard_epoch() from public;
drop trigger if exists yh_records_guard_epoch on public.yh_records;
create trigger yh_records_guard_epoch before insert or update on public.yh_records
for each row execute function public.yh_records_guard_epoch();

alter table public.yh_records enable row level security;
alter table public.yh_ledger_state enable row level security;
alter table public.yh_clear_operations enable row level security;
grant usage on schema public to anon;
revoke all on public.yh_records from public;
grant select,insert,update on public.yh_records to anon;
revoke delete on public.yh_records from anon;
revoke truncate,references,trigger on public.yh_records from anon;
-- state/receipt 不可由 anon 写：避免单独推进 epoch、伪造成功凭证。只有清空 RPC 能原子维护。
revoke all on public.yh_ledger_state from public,anon;
revoke all on public.yh_clear_operations from public,anon;
grant select on public.yh_clear_operations to anon;

drop policy if exists "yh ledger access" on public.yh_records;
drop policy if exists "yh ledger read" on public.yh_records;
drop policy if exists "yh ledger write" on public.yh_records;
drop policy if exists "yh ledger update" on public.yh_records;
create policy "yh ledger read" on public.yh_records for select to anon
  using (ledger=public.yh_request_ledger());
create policy "yh ledger write" on public.yh_records for insert to anon
  with check (ledger=public.yh_request_ledger());
create policy "yh ledger update" on public.yh_records for update to anon
  using (ledger=public.yh_request_ledger()) with check (ledger=public.yh_request_ledger());
drop policy if exists "yh clear receipt read" on public.yh_clear_operations;
create policy "yh clear receipt read" on public.yh_clear_operations for select to anon
  using (ledger=public.yh_request_ledger());
-- state 开启 RLS 且没有 anon policy/grant；header-bound definer 内部显式限定 ledger。

create or replace function public.yh_sync_capabilities()
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare
  v_ledger text;
  v_scoped boolean;
  v_epoch bigint;
begin
  v_ledger := public.yh_request_ledger();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_ledger,0));
  select exists (
    select 1 from pg_catalog.pg_constraint c
    where c.conrelid='public.yh_records'::regclass and c.contype='p'
      and (select pg_catalog.array_agg(a.attname::text order by k.ordinality)
           from pg_catalog.unnest(c.conkey) with ordinality k(attnum,ordinality)
           join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum)
          = array['ledger','id']::text[]
  ) into v_scoped;
  select s.clear_epoch into v_epoch from public.yh_ledger_state s where s.ledger=v_ledger;
  return pg_catalog.jsonb_build_object('protocolVersion',2,'conflictTarget','ledger,id',
    'ledgerScoped',v_scoped,'clearRpcEnabled',v_scoped,'clearEpoch',coalesce(v_epoch,0),
    'epochHeader','x-yh-clear-epoch','epochHeaderRequired',coalesce(v_epoch,0)>0);
end;
$$;
revoke all on function public.yh_sync_capabilities() from public;
grant execute on function public.yh_sync_capabilities() to anon;

-- 最小 definer RPC 是一个安全边界：header 唯一确定 ledger，不接收 target ledger、无动态 SQL。
-- 使 state 与 receipt 无公开写 helper，避免调用者绕过整笔事务。所有业务读写均显式 where ledger。
create or replace function public.yh_clear_ledger(p_operation_id uuid)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare
  v_ledger text;
  v_receipt public.yh_clear_operations%rowtype;
  v_epoch bigint;
  v_cleared_at bigint;
  v_count bigint;
  v_marker_id text;
  v_original_headers text;
begin
  v_ledger := public.yh_request_ledger();
  if p_operation_id is null then
    raise exception using errcode='22023', message='SYNC_CLEAR_OPERATION_ID_REQUIRED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_ledger,0));
  -- 重试先查原凭证：即使以后又清空过，也返回第一次结果，绝不再次改业务数据。
  select o.* into v_receipt from public.yh_clear_operations o
    where o.ledger=v_ledger and o.operation_id=p_operation_id;
  if found then
    return pg_catalog.jsonb_build_object('operationId',v_receipt.operation_id,
      'clearedAt',v_receipt.cleared_at,'clearedCount',v_receipt.cleared_count,'clearEpoch',v_receipt.clear_epoch);
  end if;
  if not (public.yh_sync_capabilities()->>'clearRpcEnabled')::boolean then
    raise exception using errcode='P0001', message='SYNC_CLEAR_RPC_NOT_ENABLED';
  end if;
  v_cleared_at := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint;
  insert into public.yh_ledger_state as s(ledger,clear_epoch) values (v_ledger,v_cleared_at)
    on conflict (ledger) do update set clear_epoch=greatest(s.clear_epoch+1,excluded.clear_epoch)
    returning clear_epoch into v_epoch;
  -- RPC 内部写同样通过完整 trigger 校验。只在自身事务内临时补新 epoch 头，
  -- ledger 头保持原值；成功返回前恢复原头，抛错时 GUC/数据随子事务一起回滚。
  -- 不提供绕过 trigger 的标志或可公开调用的 state mutation helper。
  v_original_headers := pg_catalog.current_setting('request.headers',true);
  perform pg_catalog.set_config('request.headers',
    (v_original_headers::jsonb || pg_catalog.jsonb_build_object('x-yh-clear-epoch',v_epoch::text))::text,true);
  select count(*) into v_count from public.yh_records r
    where r.ledger=v_ledger and r.kind<>'ledger' and not r.deleted;
  update public.yh_records set deleted=true,updated_at=v_cleared_at,
    record_updated_at=v_cleared_at,clear_epoch=v_epoch where ledger=v_ledger;
  v_marker_id := '__ledger_cleared__:' || v_ledger;
  insert into public.yh_records(id,record_id,ledger,kind,data,updated_at,record_updated_at,schema_version,clear_epoch,device_id,deleted)
    values (v_marker_id,v_marker_id,v_ledger,'ledger',
      pg_catalog.jsonb_build_object('clearedAt',v_cleared_at,'clearEpoch',v_epoch),
      v_cleared_at,v_cleared_at,2,v_epoch,'',false)
    on conflict (ledger,id) do update set record_id=excluded.record_id,kind=excluded.kind,
      data=excluded.data,updated_at=excluded.updated_at,record_updated_at=excluded.record_updated_at,
      schema_version=excluded.schema_version,clear_epoch=excluded.clear_epoch,device_id=excluded.device_id,deleted=false;
  insert into public.yh_clear_operations(ledger,operation_id,cleared_at,cleared_count,clear_epoch)
    values (v_ledger,p_operation_id,v_cleared_at,v_count,v_epoch);
  perform pg_catalog.set_config('request.headers',v_original_headers,true);
  return pg_catalog.jsonb_build_object('operationId',p_operation_id,
    'clearedAt',v_cleared_at,'clearedCount',v_count,'clearEpoch',v_epoch);
end;
$$;
revoke all on function public.yh_clear_ledger(uuid) from public;
grant execute on function public.yh_clear_ledger(uuid) to anon;

-- RECONNECT_RECONCILE_BEGIN
-- 确认快照与条件上传在同一账本事务锁内完成；响应丢失按原操作号查收据，不重放旧值。
create table if not exists public.yh_reconcile_operations (
  ledger text not null,
  operation_id uuid not null,
  pushed_count bigint not null check (pushed_count >= 0),
  primary key (ledger,operation_id)
);
alter table public.yh_reconcile_operations enable row level security;
revoke all on public.yh_reconcile_operations from public,anon;
grant select on public.yh_reconcile_operations to anon;
drop policy if exists "yh reconcile receipt read" on public.yh_reconcile_operations;
create policy "yh reconcile receipt read" on public.yh_reconcile_operations for select to anon
  using (ledger=public.yh_request_ledger());

create or replace function public.yh_reconcile_push(p_operation_id uuid,p_expected jsonb,p_rows jsonb)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare
  v_ledger text;
  v_receipt public.yh_reconcile_operations%rowtype;
  v_current jsonb;
  v_row jsonb;
  v_list jsonb;
  v_is_expected boolean;
  v_count bigint;
begin
  v_ledger := public.yh_request_ledger();
  if p_operation_id is null then
    raise exception using errcode='22023', message='SYNC_RECONNECT_INVALID_OPERATION_ID';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_ledger,0));
  -- FIRST: 即使账本/代际后来改变或重试参数已坏，也只返回原收据，绝不再次写入。
  select o.* into v_receipt from public.yh_reconcile_operations o
    where o.ledger=v_ledger and o.operation_id=p_operation_id;
  if found then
    return pg_catalog.jsonb_build_object('operationId',v_receipt.operation_id,'pushedCount',v_receipt.pushed_count);
  end if;
  if pg_catalog.jsonb_typeof(p_expected) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception using errcode='22023', message='SYNC_RECONNECT_INVALID_ARRAY';
  end if;
  if pg_catalog.jsonb_array_length(p_expected)>10000 or pg_catalog.jsonb_array_length(p_rows)>10000 then
    raise exception using errcode='22023', message='SYNC_RECONNECT_INVALID_ROW_LIMIT';
  end if;
  foreach v_is_expected in array array[true,false] loop
    v_list := case when v_is_expected then p_expected else p_rows end;
    if exists (select 1 from pg_catalog.jsonb_array_elements(v_list) x
      group by x->>'id' having count(*)>1) then
      raise exception using errcode='22023', message='SYNC_RECONNECT_INVALID_DUPLICATE_ID';
    end if;
    for v_row in select value from pg_catalog.jsonb_array_elements(v_list) loop
      if pg_catalog.jsonb_typeof(v_row) is distinct from 'object'
        or pg_catalog.jsonb_typeof(v_row->'id') is distinct from 'string'
        or pg_catalog.jsonb_typeof(v_row->'record_id') is distinct from 'string'
        or pg_catalog.jsonb_typeof(v_row->'kind') is distinct from 'string'
        or coalesce(v_row->>'id','')='' or coalesce(v_row->>'record_id','')=''
        or pg_catalog.jsonb_typeof(v_row->'data') is distinct from 'object'
        or pg_catalog.jsonb_typeof(v_row->'deleted') is distinct from 'boolean'
        or pg_catalog.jsonb_typeof(v_row->'updated_at') is distinct from 'number'
        or (v_row->>'updated_at') !~ '^(0|[1-9][0-9]*)$'
        or pg_catalog.jsonb_typeof(v_row->'record_updated_at') is distinct from 'number'
        or (v_row->>'record_updated_at') !~ '^(0|[1-9][0-9]*)$' then
        raise exception using errcode='22023', message='SYNC_RECONNECT_INVALID_ROW';
      end if;
      -- expected 是无 ledger 的固定投影；若调用者额外给 ledger，也必须与 header 一致。
      if (not v_is_expected or v_row ? 'ledger') and
        (pg_catalog.jsonb_typeof(v_row->'ledger') is distinct from 'string' or v_row->>'ledger' is distinct from v_ledger) then
        raise exception using errcode='42501', message='SYNC_LEDGER_HEADER_MISMATCH';
      end if;
      if not (v_is_expected and v_row->>'kind'='ledger' and v_row->>'id'='__ledger_cleared__:' || v_ledger) then
        if v_row->>'kind' not in ('product','batch','order','line','adjustment','session','setting')
          or v_row->>'id' is distinct from (v_row->>'kind') || ':' || (v_row->>'record_id') then
          raise exception using errcode='22023', message='SYNC_RECONNECT_INVALID_ID_KIND';
        end if;
      end if;
    end loop;
  end loop;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id',r.id,'record_id',r.record_id,'kind',r.kind,'data',r.data,'updated_at',r.updated_at,
    'record_updated_at',r.record_updated_at,'deleted',r.deleted) order by r.id collate "C"),'[]'::jsonb)
    into v_current from public.yh_records r where r.ledger=v_ledger
    and not (r.kind='setting' and r.record_id in ('deviceId','deviceName','operatorSelf','sync-unknown-kinds'));
  if v_current is distinct from p_expected then
    raise exception using errcode='P0001', message='SYNC_RECONNECT_BASELINE_CHANGED';
  end if;
  -- 保留完整业务 data；不改 request.headers，不绕过 epoch trigger。每条行仍验证 header/state/clear_epoch。
  insert into public.yh_records as r(id,record_id,ledger,kind,data,updated_at,record_updated_at,schema_version,clear_epoch,device_id,deleted)
    select x->>'id',x->>'record_id',v_ledger,x->>'kind',x->'data',(x->>'updated_at')::bigint,
      (x->>'record_updated_at')::bigint,coalesce((x->>'schema_version')::int,2),
      coalesce((x->>'clear_epoch')::bigint,0),coalesce(x->>'device_id',''),(x->>'deleted')::boolean
    from pg_catalog.jsonb_array_elements(p_rows) x where x->>'ledger'=v_ledger
    on conflict (ledger,id) do update set record_id=excluded.record_id,kind=excluded.kind,data=excluded.data,
      updated_at=excluded.updated_at,record_updated_at=excluded.record_updated_at,schema_version=excluded.schema_version,
      clear_epoch=excluded.clear_epoch,device_id=excluded.device_id,deleted=excluded.deleted where r.ledger=v_ledger;
  get diagnostics v_count = row_count;
  insert into public.yh_reconcile_operations(ledger,operation_id,pushed_count) values(v_ledger,p_operation_id,v_count);
  return pg_catalog.jsonb_build_object('operationId',p_operation_id,'pushedCount',v_count);
end;
$$;
revoke all on function public.yh_reconcile_push(uuid,jsonb,jsonb) from public;
grant execute on function public.yh_reconcile_push(uuid,jsonb,jsonb) to anon;
-- RECONNECT_RECONCILE_END

-- 不接受遗留的任意放行/DELETE policy；未知旧 policy 必须人工审核后再迁移，不能静默保留。
do $$
begin
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid='public.yh_records'::regclass
      and p.polname not in ('yh ledger read','yh ledger write','yh ledger update')) then
    raise exception 'SYNC_PREPARE_UNREVIEWED_RECORD_POLICY';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid='public.yh_ledger_state'::regclass)
    or exists (select 1 from pg_catalog.pg_policy p where p.polrelid='public.yh_clear_operations'::regclass
      and p.polname<>'yh clear receipt read')
    or exists (select 1 from pg_catalog.pg_policy p where p.polrelid='public.yh_reconcile_operations'::regclass
      and p.polname<>'yh reconcile receipt read') then
    raise exception 'SYNC_PREPARE_UNREVIEWED_PROTOCOL_POLICY';
  end if;
end;
$$;
notify pgrst, 'reload schema';
commit;
