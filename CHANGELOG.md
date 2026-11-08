# Changelog

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号沿用 `package.json`。
（仓库未创建 LICENSE，见 `docs/07` 的人工待办。）

## [Unreleased] - 2026-11-08

### Added

- 本地自动备份：独立 `yanhuo-erp-backup` 库、收摊后自动快照、手动备份/恢复/导出，保留最近 3 个日期 + 1 份迁移前快照（T02 / T07）。
- 迁移前快照：Dexie 升级或 `migrateSessions` 执行前，用原生 IndexedDB 落 `pre-migrate` 快照（T07）。
- 新版本提示条：PWA 改为 `prompt`，出现「有新版本，收摊后再更新」，不再自动 reload（T03）。
- 单据草稿覆盖 `new` / `edit` / `patch` 三种模式，reload 后按目标校验恢复（T03）。
- 数据层单测与覆盖率门禁：repo / merge / outbox / 场次迁移用例，`src/db/**` 行覆盖 ≥ 60%（T08）。
- 同步冲突留痕：Dexie v4 `conflicts` 表，设置页显示「待核对 N 条」（T09）。
- E2E 最小集：PR 上跑 `check-default-sync` + `e2e-smoke` + `e2e-sync` + `e2e-offline`（T04 / T04a）。

### Changed

- 接入 ESLint 9（flat config）+ Prettier；CI 在单测前跑 `pnpm lint`（warn 起步）（T05）。
- `deploy.yml` 的单测步骤改为 `pnpm test:cov`，低于阈值即失败（T08）。
- 同步推送增加业务时间 `record_updated_at`，拉取水位仍用 `updated_at`（T09）。
- 同步失败按 1s→2s→4s…→60s 退避，成功重置；10s 轮询在退避期间让路（T09）。
- 删除无路由入口的 v1 收银：`SellPage.tsx`、`checkout`、`CheckoutInput`、`CartLineInput`（T06）。

### Fixed

- 远端已存在、作废状态相同的订单，编辑不再被静默丢弃；按业务时间新者胜（T09）。
- 远端缺 `record_updated_at` 列时，用记录自身 `updatedAt` 兜底判定，远端编辑在迁移执行前也能生效（T09b）。
- 缺列降级只在第一次 push 重试的问题：确认缺列后，后续 payload 直接省略该列，避免持续 400（T09b / T09 计划外修复）。
- 旧版 `e2e-smoke` / `e2e-sync` / `e2e-offline` / `check-default-sync` 脚本仍在等 v1 商品网格，已迁到 v2 场次流程（T04a）。

### Security

- 删除 `supabase/schema.sql` 末尾的 `using (true)` 回退方案，改为禁止性警告（T01）。
- 在 `docs/03` 披露：内置 URL / anonKey / ledgerKey 随公开前端包发布，不是秘密；补充 RLS 实际边界与两台设备轮换步骤（T01）。
- `syncDefaults.ts` 注释改为显式风险声明，设置页文案说明「内置账本为共享密钥，仅用于自用」（T01）。
- 未轮换线上 `ledgerKey`、未执行任何 Supabase SQL（人工待办，见 `docs/07`）。

## [0.4.0] - 2026-11-08

### Added

- v2 场次记账：`sessions` 表、收摊结账、补记、按场次报表与历史场次。
- 双设备自动云同步（Supabase PostgREST + `x-ledger-key` RLS、本地发件箱、断网补发）。
- PWA 离线可用、安装到主屏幕、手动导出/导入合并。
- 开单 / 进货 / 库存 / 报表 / 商品 / 设置页面与 GlassKit 液态玻璃设计。

### Changed

- 收银从 v1 实时结算切换到 v2 场次模型；`SellPage` 暂留作回滚（后于 T06 删除）。