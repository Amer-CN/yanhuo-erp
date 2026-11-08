-- 同步冲突判定：新增业务修改时间列 + 索引。
-- 这是人工步骤：由维护者在 Supabase SQL Editor 执行；执行 Agent 不执行任何 SQL。
-- 旧客户端不发送该列时使用默认值 0，不影响现有同步。

alter table public.yh_records
  add column if not exists record_updated_at bigint not null default 0;

create index if not exists yh_records_ledger_record_updated
  on public.yh_records (ledger, record_updated_at);

-- 执行后验证：
--   select column_name, data_type
--     from information_schema.columns
--    where table_name = 'yh_records' and column_name = 'record_updated_at';
-- 期望：record_updated_at | bigint

-- 回滚（默认不需要；旧客户端不依赖该列）：
--   drop index if exists public.yh_records_ledger_record_updated;
--   alter table public.yh_records drop column if exists record_updated_at;