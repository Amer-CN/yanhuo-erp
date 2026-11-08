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
  device_id text not null default '',
  deleted boolean not null default false
);

create index if not exists yh_records_ledger_updated
  on public.yh_records (ledger, updated_at);

create index if not exists yh_records_ledger_record_updated
  on public.yh_records (ledger, record_updated_at);

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

-- 禁止改为 using (true)：那会允许任何持有 anon key 的客户端读写全部账本。