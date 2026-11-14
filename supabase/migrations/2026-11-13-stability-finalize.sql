-- B07 完成阶段：只有两台 PWA 均已升级、独立测试库验收通过后，由维护者人工执行。
-- 保留全部业务数据；不恢复全表 id 唯一、不 CASCADE、不复制/清空业务表。
-- 实际主键为 (ledger,id) 时幂等。能力 RPC 从真实主键派生，此事务提交后才启用清空。
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
-- 先锁表再核对目录，避免约束检查与 DDL 之间被其他迁移改变。
lock table public.yh_records in access exclusive mode;
do $$
declare
  v_pk_name name;
  v_pk_index oid;
  v_pk_columns text[];
begin
  if pg_catalog.to_regprocedure('public.yh_sync_capabilities()') is null
    or pg_catalog.to_regprocedure('public.yh_clear_ledger(uuid)') is null
    or pg_catalog.to_regclass('public.yh_ledger_state') is null
    or pg_catalog.to_regclass('public.yh_clear_operations') is null then
    raise exception 'SYNC_FINALIZE_PREPARE_REQUIRED';
  end if;
  select c.conname,c.conindid,
    (select pg_catalog.array_agg(a.attname::text order by k.ordinality)
      from pg_catalog.unnest(c.conkey) with ordinality k(attnum,ordinality)
      join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum)
    into v_pk_name,v_pk_index,v_pk_columns
    from pg_catalog.pg_constraint c where c.conrelid='public.yh_records'::regclass and c.contype='p';
  if v_pk_columns is distinct from array['id']::text[]
    and v_pk_columns is distinct from array['ledger','id']::text[] then
    raise exception 'SYNC_FINALIZE_UNEXPECTED_PRIMARY_KEY: %',v_pk_columns;
  end if;
  if exists (select 1 from pg_catalog.pg_constraint c
      where c.contype='f' and c.confrelid='public.yh_records'::regclass) then
    raise exception 'SYNC_FINALIZE_REFERENCING_FOREIGN_KEY: review referencing constraints first';
  end if;
  -- 仅豁免本事务即将删除的旧 id PK；所有其他 UNIQUE 的键必须直接包含 ledger。
  -- INCLUDE 不参与唯一性；表达式依赖不推断（如 lower(ledger) 仍 fail closed）。
  if exists (
    select 1 from pg_catalog.pg_index i where i.indrelid='public.yh_records'::regclass
      and i.indisunique
      and not (v_pk_columns = array['id']::text[] and i.indexrelid=v_pk_index)
      and not exists (
        select 1 from pg_catalog.unnest(i.indkey) with ordinality k(attnum,ordinality)
        join pg_catalog.pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
        where k.ordinality<=i.indnkeyatts and a.attname='ledger'
      )
  ) then
    raise exception 'SYNC_FINALIZE_GLOBAL_ID_UNIQUENESS: review unique indexes without a direct ledger key first';
  end if;
  -- EXCLUDE 一律拒绝，不推断表达式、操作符或 ledger 范围语义。
  if exists (select 1 from pg_catalog.pg_constraint c
      where c.conrelid='public.yh_records'::regclass and c.contype='x')
    or exists (select 1 from pg_catalog.pg_index i
      where i.indrelid='public.yh_records'::regclass and i.indisexclusion) then
    raise exception 'SYNC_FINALIZE_EXCLUSION_CONSTRAINT: review exclusion constraints first';
  end if;
  -- 幂等也要核对最终状态，不能跳过后来新增的 FK / UNIQUE / EXCLUDE 约束。
  -- 已有复合 PK 不要求准备索引仍保留原名（USING INDEX 可将索引更名为真实 PK 名）。
  if v_pk_columns = array['ledger','id']::text[] then return; end if;
  if not exists (
    select 1 from pg_catalog.pg_index i
    where i.indexrelid=pg_catalog.to_regclass('public.yh_records_ledger_id_uq')
      and i.indrelid='public.yh_records'::regclass
      and i.indisunique and i.indisvalid and i.indisready and not i.indisprimary
      and i.indpred is null and i.indexprs is null and i.indnkeyatts=2 and i.indnatts=2
      and not exists (select 1 from pg_catalog.pg_constraint c where c.conindid=i.indexrelid)
      and (select pg_catalog.array_agg(a.attname::text order by k.ordinality)
        from pg_catalog.unnest(i.indkey) with ordinality k(attnum,ordinality)
        join pg_catalog.pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum)
        = array['ledger','id']::text[]
  ) then
    raise exception 'SYNC_FINALIZE_PREPARED_UNIQUE_INDEX_REQUIRED';
  end if;
  -- 唯一动态 SQL 仅用于经 pg_constraint 查证、format(%I) 引用的真实约束标识符。
  execute pg_catalog.format('alter table public.yh_records drop constraint %I',v_pk_name);
  execute pg_catalog.format('alter table public.yh_records add constraint %I primary key using index yh_records_ledger_id_uq',v_pk_name);
end;
$$;
notify pgrst, 'reload schema';
commit;
