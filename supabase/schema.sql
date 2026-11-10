-- 烟花账 · Supabase 同步表
-- 在 Supabase 控制台 → SQL Editor 里整段执行一次即可。

create table if not exists public.yh_records (
  id text primary key,
  record_id text not null,
  ledger text not null,
  kind text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at bigint not null,
  -- 业务修改时间（毫秒）；冲突判定用，旧客户端不写时默认 0
  record_updated_at bigint not null default 0,
  -- 记录格式版本；旧客户端不写时默认 1
  schema_version int not null default 1,
  device_id text not null default '',
  deleted boolean not null default false
);

create index if not exists yh_records_ledger_updated
  on public.yh_records (ledger, updated_at);

-- 复合游标（updated_at, id）：拉取翻页按这两列排序与比较，同毫秒记录不会漏。
-- 老库升级：单独执行下面这条即可（可重复执行）。
create index if not exists yh_records_ledger_updated_id
  on public.yh_records (ledger, updated_at, id);

create index if not exists yh_records_ledger_record_updated
  on public.yh_records (ledger, record_updated_at);

alter table public.yh_records enable row level security;

-- 权限：只给「读 / 增 / 改」，**不授予 delete**。
-- 清空账本走软删除（PATCH 把 deleted 置 true），避免任何拿到同步码的人一键抹掉账本。
-- 需要物理删除时用 service_role 在控制台操作（它 bypass RLS）。
grant select, insert, update on public.yh_records to anon;
revoke delete on public.yh_records from anon;

-- 只允许携带正确 x-ledger-key 头的请求访问对应账本。
-- 同步码就是 x-ledger-key，客户端只在请求头里发送，不进 URL。
drop policy if exists "yh ledger access" on public.yh_records;
drop policy if exists "yh ledger read" on public.yh_records;
drop policy if exists "yh ledger write" on public.yh_records;
drop policy if exists "yh ledger update" on public.yh_records;

create policy "yh ledger read" on public.yh_records
  for select
  to anon
  using (
    ledger = coalesce(current_setting('request.headers', true)::json ->> 'x-ledger-key', '')
  );

create policy "yh ledger write" on public.yh_records
  for insert
  to anon
  with check (
    ledger = coalesce(current_setting('request.headers', true)::json ->> 'x-ledger-key', '')
  );

-- 软删除也走 update：using 决定能改哪些行，with check 保证改完 ledger 不被挪走
create policy "yh ledger update" on public.yh_records
  for update
  to anon
  using (
    ledger = coalesce(current_setting('request.headers', true)::json ->> 'x-ledger-key', '')
  )
  with check (
    ledger = coalesce(current_setting('request.headers', true)::json ->> 'x-ledger-key', '')
  );

-- 禁止改为 using (true)：那会允许任何持有 anon key 的客户端读写全部账本。

-- ---------------------------------------------------------------- 回滚（v2 → v1）
-- 若需要退回「允许 DELETE」的旧行为，在 SQL Editor 执行：
--
--   grant delete on public.yh_records to anon;
--   drop policy if exists "yh ledger read"   on public.yh_records;
--   drop policy if exists "yh ledger write"  on public.yh_records;
--   drop policy if exists "yh ledger update" on public.yh_records;
--   create policy "yh ledger access" on public.yh_records
--     for all to anon
--     using (ledger = coalesce(current_setting('request.headers', true)::json ->> 'x-ledger-key', ''))
--     with check (ledger = coalesce(current_setting('request.headers', true)::json ->> 'x-ledger-key', ''));
--
-- 注意：回滚后旧客户端（用 DELETE 清空）能继续工作，但「任意持码者可清空账本」的风险也一并回来。