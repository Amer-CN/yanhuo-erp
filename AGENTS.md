# 烟花进销存（F:\AIXM\烟花爆竹）

自用烟花摊进销存 PWA：两个人、两台手机，摊位断网也能开单，联网自动同步。

## 线上

- 应用：<https://amer-cn.github.io/yanhuo-erp/>
- 仓库：<https://github.com/Amer-CN/yanhuo-erp>（push 到 main 自动测试 + 部署）
- 云同步：Supabase（publishable key + 内置同步码，默认开启，见[云同步设置](docs/03-云同步设置.md)）；恢复后暂停，重连需预览确认。
- 本轮稳定性修复只交付本地候选；未经另行授权不 push、不 deploy、不执行生产 SQL、不写真实账本。

## 命令

```bash
pnpm install
pnpm dev      # http://localhost:5173
pnpm build    # tsc --noEmit && vite build
pnpm test     # 最终用例数与覆盖率见稳定性修复总方案的最终验收记录
pnpm perf     # 数据层性能基线（tests/perf/*.perf.ts，独立配置，不进 pnpm test）
```

端到端需要 Playwright + Chromium；[README](README.md#开发)列出 Bash 命令，[运维手册](docs/08-运维手册.md#12-本轮候选的本地门禁与交付边界)列出 PowerShell、端口与独立 SQL/HTTP 验证前置条件。共用 [E2E action](.github/actions/e2e/action.yml)保留 dev 5173 / preview 4173、原有回归和 a11y 观察期，新增八项稳定性回归为阻塞步骤。缺少独立数据库/HTTP 环境时应记“未验证”，不能把环境缺失记成产品失败、通过或 skip。

## 技术栈

React 18 + TypeScript + Vite；Dexie（IndexedDB）；GlassKit 1.40 + lucide-react；vite-plugin-pwa；Supabase（PostgREST + RLS）。

## 目录

- `src/db/`：业务层 `repo` / `calc` / `merge`，同步层 `sync` / `syncResolve` / `syncControl` / `syncReconnect` / `syncReconcile` / `syncProtocol` / `outbox`，恢复与备份 `dataRecovery` / `backup`；其余类型、seed、场次和工具模块见目录。
- `src/ui/pages/`：7 个页面；`src/ui/kit.tsx` 组件；`src/ui/useRecordDraft.ts` 开单草稿 hook（持久化工具在 `recordDraft.ts`）；`src/tokens.css` 设计令牌；`src/styles.css` 应用层样式
- `supabase/schema.sql`：云端建表；`docs/`：需求、使用说明、云同步、设计系统
- `scripts/`：E2E 与诊断脚本
- **`docs/代码异味基线-20261110.md`：重构基线（36 条 → 遗留 5 条，均 Minor）。动结构前先读**；文中 M1–M6 是重构批次编号，与下文产品里程碑 M6（真机试用）无关

## 约定 / 红线

1. 本地优先：写入先落 IndexedDB + outbox，联网再同步；断网不得阻断开单。
2. 不复制金蝶反编译代码 / DLL（只借字段语义）。
3. 不在 `E:\测试` 干活；不删 `E:\测试\.work\rea-full` 的 `reports/`、`*.jsonl`、`tools/`。
4. 跨盘引用写绝对路径。
5. 测试脚本默认 `localStorage['yh-sync-disabled']='1'`，别让测试数据写真实账本。
6. 重构/改结构前先读[异味基线](docs/代码异味基线-20261110.md)的「已消除」「已关闭」两节——**不得重复报告或重复重构**；基线回写由本轮集成者负责，遵守各代理文件白名单。
7. 恢复/撤销合并只恢复本机、清旧队列并持久暂停；重连先只读预览、逐订单组选择，不清整个云账本，不整库标脏。云端缺少所需 RPC 能力时拒绝危险操作并保留本机数据；清云结果未知必须重试同一 operationId。

## 当前状态

**本地整合与独立真实协议验收通过，生产与目标真机待人工执行。** 既有线上版本与本轮候选分开；候选未部署，真实 loopback PostgreSQL/PostgREST HTTP 与多连接已验收，生产迁移/云环境与目标真机仍未执行。任务索引、最终测试凭证与发布边界只在[稳定性修复总方案](docs/superpowers/plans/2026-11-13-stability-repair.md)维护，其他文档不固定测试数。文档收尾断点见[收尾进度](docs/stability-closeout/PROGRESS.md)，续办前同时读其[阻塞事项](docs/stability-closeout/BLOCKED.md)；该进度文件不是第二任务索引。

本地代码与验收记录已在 `stability-repair` 分支，当前 `stability-closeout` 可按明确白名单整合文档/规则、验收脚本及必要工具链定点修补，并可在隔离 loopback 环境验收 PostgreSQL/PostgREST；原 `main` 只读。真实 loopback HTTP 与多连接结果是本轮有效验收，但不能推导生产迁移、生产云或目标真机已通过。生产迁移、push、deploy、真实账本和两台目标手机演练不在本轮授权内，逐项保持人工 pending。
