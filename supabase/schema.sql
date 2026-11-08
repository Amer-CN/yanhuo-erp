-- 烟花账 · Supabase 同步表
-- 在 Supabase 控制台 → SQL Editor 里整段执行一次即可。

create table if not exists public.yh_records (
  id text primary key,
  record_id text not null,
  ledger text not null,
  kind text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at bigint not null,
  device_id text not null default '',
  deleted boolean not null default false
);

create index if not exists yh_records_ledger_updated
  on public.yh_records (ledger, updated_at);

alter table public.yh_records enable row level security;

grant select, insert, update, delete on public.yh_records to anon;

-- 只允许携带正确 x-ledger-key 头的请求访问对应账本。
-- 同步码就是 x-ledger-key，客户端只在请求头里发送，不进 URL。
drop policy if exists "yh ledger access" on public.yh_records;
create policy "yh ledger access" on public.yh_records
  for all
  to anon
  using (
    ledger = coalesce(current_setting('request.headers', true)::json ->> 'x-ledger-key', '')
  )
  with check (
    ledger = coalesce(current_setting('request.headers', true)::json ->> 'x-ledger-key', '')
  );

-- 如果上面的 request.headers 方案在你的 Supabase 版本里不通（表现为 401/403 或空结果），
-- 且这个项目只有你自己用，可以退回到「单人账本」策略：
-- drop policy if exists "yh ledger access" on public.yh_records;
-- create policy "yh ledger access" on public.yh_records
--   for all to anon using (true) with check (true);
-- 注意：退回后，任何拿到你 anon key 的人都能读写这张表，请勿把 key 发到公开地方。