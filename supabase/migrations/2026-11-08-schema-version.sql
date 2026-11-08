-- 云端行加 schema_version，供旧客户端识别新数据格式。
-- 这是人工步骤：由维护者在 Supabase SQL Editor 执行；执行 Agent 不执行任何 SQL。
-- 旧客户端不发送该列时使用默认值 1；新客户端推送 2。

alter table public.yh_records
  add column if not exists schema_version int not null default 1;

-- 执行后验证：
--   select column_name, data_type, column_default
--     from information_schema.columns
--    where table_name = 'yh_records' and column_name = 'schema_version';
-- 期望：schema_version | integer | 1

-- 回滚：
--   alter table public.yh_records drop column if exists schema_version;