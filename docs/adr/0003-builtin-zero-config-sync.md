# ADR 0003：内置零配置同步凭据

- Status: Accepted（风险已披露，未根治）
- Date: 2026-11-08

## Context

摊主不是开发者，要求「两台手机打开同一个网址就自动是同一本账」。任何需要手动填 URL/key/同步码的方案都会在真机试用时变成支持成本。

## Decision

把 `url`、publishable `anonKey`、`ledgerKey` 内置在 `src/db/syncDefaults.ts`，随前端包发布；用户仍可在设置页换成自己的项目/同步码。已确认它们不是秘密，并在 `docs/03` 写明 RLS 边界与轮换步骤；禁止退回 `using (true)`。

## Consequences

- 正面：零配置可用，第二台手机打开即同步。
- 代价/风险：任何打开线上站点的人都能从 bundle 拿到三项，对 `yh_records` 做本账本的读写；TD-01 仍为 Critical，根治需 Supabase Auth + 设备级 token。
- 运维约束：轮换必须两台设备同时在场、先导出备份（见运维手册第 9 节）。