# ADR 0002：Supabase 单表 JSONB + ledger RLS

- Status: Accepted
- Date: 2026-11-08

## Context

两个人、两台手机、自用规模。需要最少的后端运维，同时不能让同一 Supabase 项目里的其他数据与本账本混在一起。

## Decision

云端只建一张 `public.yh_records`（`id`、`record_id`、`ledger`、`kind`、`data jsonb`、`updated_at`、`device_id`、`deleted` 等），用 `kind` 区分商品/批次/订单/明细/调整/场次/设置；RLS 策略要求请求头 `x-ledger-key` 与行上的 `ledger` 相等。

## Consequences

- 正面：无需为 7 类记录建 7 张表；换字段不改 DDL；迁移成本低。
- 代价：无法按业务字段建索引；schema 演进靠 `schema_version` 与客户端容错（TD-15 / T14）。
- 安全边界：RLS 能阻止跨账本，但阻止不了拿到本账本同步码的人；同步码随公开前端包发布（见 ADR 0003）。