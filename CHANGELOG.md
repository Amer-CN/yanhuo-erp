# Changelog

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号沿用 `package.json`。
（仓库未创建 LICENSE，见 `docs/07` 的人工待办。）

## [Unreleased]

**2026-11-15 交付状态：本地整合、门禁与独立真实协议验收通过，生产/目标真机待人工执行。** 候选未部署，未执行生产迁移或真实账本操作；本机真实 PostgreSQL/PostgREST HTTP 与多连接已留证。最终用例数、覆盖率、命令输出和边界以[稳定性修复总方案](docs/superpowers/plans/2026-11-13-stability-repair.md#最终验收记录2026-11-15)为准，发布顺序见[人工检查表](docs/stability-closeout/RELEASE-CHECKLIST.md)。

### 交付收尾（2026-11-15）

- 安全整合原 main 的文档/规则成果，235 份遗留文件全部逐项哈希保全；历史截图、探针及旧计划保留适用日期和外置位置，不覆盖现役方案。
- Vite 从 5.4.21 定点升级并锁定 6.4.5，修复开发工具已知 High；React、Vitest、PWA 与业务/协议实现保持原候选。生产依赖 audit 为0，开发告警仍有5 Moderate/1 Low，未宣称零风险。
- 独立 PostgreSQL16.16 / PostgREST16.5 验收覆盖两安装路径、复合冲突/RLS/epoch、清空并发、重连基线漂移拒绝及实际丢响应幂等重试；另外观察长事务账本锁竞争的两种提交顺序。
- SQL验收入口增加连接前 loopback/库名/query护栏与密码脱敏；修复 psql16 忽略 `\\quit 2` 参数导致错误配置退出0的问题。新增真实IndexedDB操作号/未确认/WAL写失败护栏，保留变异失败凭证。

### 稳定性修复候选（2026-11-13 起）

- 编辑已有订单仅“保存修改”；新单/补记的继续保存与建商品返回保留原目标和草稿，页面加载失败可重试。库存草稿按商品隔离，历史详情与撤销采用独立原生按钮，嵌套弹层只由顶层处理键盘焦点。
- outbox 确认绑定实际发送版本；入站校验金额与明细完整性，跨页父子行暂存并补齐，远端改单撤销按完整订单和业务时间处理。
- 恢复快照、撤销合并仅替换本机，清旧队列并持久暂停同步，保留其他设备独有数据。重连先只读预览、逐订单组选择；本机版本上传要求远端额外条件写 RPC 能力、基线原子校验和结果凭证，防止预览后第三台设备更新被覆盖。本地回归与独立真实服务端 HTTP/多连接已通过；生产与目标真机仍待人工验收。
- 云端迁移包分 prepare / finalize；新库使用 `(ledger,id)` 主键，旧库 prepare 保留 `id` 主键并补复合唯一约束与能力 RPC，只有两台设备确认升级后才人工 finalize。清云采用账本头限定、固定 search_path 的最小 definer 事务 RPC，保存 receipt/current epoch；旧两请求清云路径退役，缺 RPC 不清本机，未知结果重试同一 operationId。
- PWA “稍后”后可在设置页检查/确认更新，并查看当前构建标识；更新失败保留重试入口。目标手机安装态仍待验收。
- 共用 E2E action 新增稳定性、同步恢复、合并、弹层键盘、页面恢复、UI 边界、SQL 帮助、PWA 更新八项阻塞步骤；保留原有 build/dev/preview/smoke/sync/offline 与 a11y 观察期。独立 SQL/RLS、HTTP和并发验收的本机结果见总方案；真实生产环境与目标真机仍单列pending，不把mock/WASM或loopback结果外推。

### 2026-11-09 至 2026-11-12 的历史功能补记

从原 main 遗留资料选择性整合：每日全量重放/续扫与5分钟重叠窗口、跨设备改动提示和首次下载反馈；报表今天已结账合计、成本待补/作废单与吸顶；数量校验、连点防重、离线回执和 shell 网格动作条；禁止删除已售批次与已结账快照重算。具体日期/修复口径见[异味基线](docs/代码异味基线-20261110.md)，不把旧 PATCH+POST 清云或“撤销DELETE即不能清空”带回现役协议。

以下为 2026-11-08 的既有未发布记录：

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
- 数据层性能（详见 `docs/performance-20261118.md`）：报表场次汇总改一次批量分组（`calc.sessionReports`），
  报表页历史列表与「今天」合计不再逐场扫全库；`fifoAllocate` 排序键预算一次；同步冲突留痕改批量落库。
  同负载 A/B：40 场汇总约 -77%、FIFO 约 -25%、冲突落库约 -71%，口径逐值不变。
- 首屏启动链（详见 `docs/performance-frontend-20261118.md`）：启动快照与场次迁移改为
  「索引 count 判断」快路径，不再每次启动把整库读进 JS；进货/开单编辑器在首屏提交后立即预取，
  其余页面空闲再取；Dexie 改现代 ES 构建。Slow 4G + 4× CPU 下 TBT 218→113ms、
  首屏可交互 1513→1408ms、FCP/LCP 1404→1332ms、INP 80→64ms，业务口径与交互不变。

### Fixed

- 远端已存在、作废状态相同的订单，编辑不再被静默丢弃；按业务时间新者胜（T09）。
- 远端缺 `record_updated_at` 列时，用记录自身 `updatedAt` 兜底判定，远端编辑在迁移执行前也能生效（T09b）。
- 缺列降级只在第一次 push 重试的问题：确认缺列后，后续 payload 直接省略该列，避免持续 400（T09b / T09 计划外修复）。
- 旧版 `e2e-smoke` / `e2e-sync` / `e2e-offline` / `check-default-sync` 脚本仍在等 v1 商品网格，已迁到 v2 场次流程（T04a）。
- `e2e-merge` 仍在等已被内联回执取代的「已记 1 单」toast，改回 `wait_for_save_receipt`（与 `e2e-smoke` 同口径），脚本恢复可运行。

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