# 稳定性候选交付收尾进度

更新：2026-11-15（Asia/Shanghai）。本地整合内容、独立验收及持久归档已完成，本地提交收尾中；未 push、未部署、未执行生产 SQL、未操作真实账本或轮换凭据、未做目标真机。

## 断点入口

续办先读本文与 [BLOCKED](BLOCKED.md)。稳定性修复任务及最终验收的唯一索引仍是[总方案](../superpowers/plans/2026-11-13-stability-repair.md)。历史实现不重做；5 条结构 Minor 与3项大账本性能债保留为后续任务。

## 现场与保全

- 原 main：`F:\AIXM\烟花爆竹`，`0953a9e5763cf402a0795a8e5c894b58848c036f`；原件未修改，仍保留其17份 tracked 差异与218份 untracked。
- 修复基线：`F:\AIXM\烟花爆竹\.agents\worktrees\stability-repair`，`b738634d2115f67c0d5a133811b5b2dd4a98039f`。
- 整合分支/树：`stability-closeout`，从该 `b738634` 创建，完成后保留。
- 原 main 的历史 preview PID 5148 / `127.0.0.1:4174` 于2026-11-12启动，本轮未触碰。
- 本轮前端 dev/preview 与 PostgreSQL/PostgREST/代理均由本轮管理的runner启动，结束后所有端口已核实关闭。
- 原资料唯一保全根：`F:\AIXM\烟花爆竹-closeout-evidence-20261115`，主 manifest 列235项路径、大小与SHA256，binary tracked patch SHA256 `f3641c0811ef4273d4264a993220e6837882c30af52faae560b9bf115d2130a3`。共158643466 bytes（tracked 345714、untracked 158297752）；二次逐文件哈希复核235/235相符，main untracked清单无增/缺，无唯一资料丢失。
- 逐项去向在[LEGACY-INVENTORY](LEGACY-INVENTORY.md)及[legacy-manifest.json](legacy-manifest.json)。218项未跟踪成果为0已整合原件、15精确SHA重复（副本仍保留）、203应保留；149图仅做哈希/引用判重，仅抽看一张样本，不称逐图视觉审计。3份旧同名计划不覆盖现役计划。所有唯一历史原件均在F盘持久位置。

## 本地门禁

最终版本：Vite精确锁为6.4.5。Vite 6.4.4曾完成门禁但被后续audit发现仅影响该版本的Moderate（GHSA-8g5g-mxqh-grgj），已作为拒绝中间态归档；下列结果均针对6.4.5。

| 验收 | 最终实测 | 证据 |
|---|---|---|
| `pnpm install --frozen-lockfile` | exit 0（Node24） / Node22.22.1隔离副本exit0 | `E:\Temp\yh-closeout-20261115\core-final\frozen-install.log`、`node22\final-clean-results.json` |
| `pnpm exec tsc --noEmit` | Node24与Node22均exit 0 | `core-final\tsc.log`、`node22\final-clean-results.json` |
| `pnpm lint` | Node24与Node22均exit 0，0 error / 30 warning | `core-final\lint.log`、`node22\final-clean-results.json` |
| `pnpm test:cov` | Node24与Node22均29 files / 331 passed / 0 skip；Node24 lines90.86%/branches85.58%/functions92.62%、sync lines88.81%；Node22 lines91.42%/branches85.67%/functions92.92%、sync lines88.81%。原阈值未变 | `core-final\test-cov.log`、`node22\final-clean-results.json` |
| `pnpm build` | Node24 exit0 / 25 precache / 890.54KiB；Node22 exit0 / 25 precache / 890.53KiB；backup动态导入提示保留 | `core-final\build.log`、`node22\final-clean-results.json` |
| `python -m unittest discover -s tests -p 'test*.py'` | 17/17 passed；HTTP-only输入收紧后重新全量17/17 | `core-final\python.log`、`python-closeout-final.log` |
| `git diff --check` | exit 0 | `core-final\diff-check.log` |
| 浏览器门禁 | 固定dist 14/14组通过、0 skip；F01 16/16、恢复7/7、UI edge12/12、SW更新5组；src/supabase/dist前后哈希相同 | `E:\Temp\yh-closeout-20261115\browser-final\results.json` |
| 官方npm audit | 生产0；全依赖0 High / 5 Moderate / 1 Low；非零audit exit原样保留，不称零风险 | `core-final\audit-prod-after.log`、`core-final\audit-all-after.log` |

命令/exit/time矩阵在 `core-final\core-gates.json`。此外，Node **22.22.1** 便携运行时也在不含node_modules/.git的隔离副本中用本机pnpm12.3.4重跑 frozen install、tsc、lint、test:cov与build，全部exit0（331例/0 skip，lint0/30，coverage lines91.42%、branches85.67%、functions92.92%、sync lines88.81%，build25 entries/890.53KiB）；完整输出与逐文件源哈希见 `node22\final-clean-results.json` / `node22\project-final-manifest.json`。未改系统Node或全局配置。未用 `|| true`、未删测试/skip、未降低覆盖率门槛。

Node22专用兼容性门禁在全部协议/文档最终变更前运行；其源文件SHA清单可与最终候选manifest核对，Node24为提交前完整最终代码门禁。浏览器14组在final Vite6.4.5核心实现/资源构建后、HTTP文档收尾之前运行，src/supabase/dist哈希相同；最终重建输出资源名相同。

## 独立真实服务验收

便携官方 PostgreSQL 16.16 / PostgREST 16.5 只解压在专用`E:\Temp\yh-closeout-20261115\portable-db`。未安装服务、未改全局PATH/代理/配置；服务只绑定127.0.0.1。`anon`为NOLOGIN/NOSUPERUSER/NOBYPASSRLS；owner不走HTTP；authenticator仅SET ROLE anon。

- 新库 `schema.sql` 与旧库 `prepare → finalize` 两路径，现役 `supabase/tests/stability.sql` fixture 均通过并 ROLLBACK；入口9类负向拒绝与恢复正常路径通过：`sql-real-final\results.json`，17个受控操作。
- 连接前SQL wrapper拒绝错误URL/encoded host、库名不一致、无数据库标记；psql16忽略 `\\quit 2` 参数导致exit0的旧入口缺口已修为ON_ERROR_STOP异常并实测；URL密码不进argv或输出；正常路径恢复通过：`sql-wrapper-final\results.json`，19个操作。
- 额外旧库样本含1条唯一业务历史行：先验证旧 `PRIMARY KEY(id)`，执行 prepare/finalize并各重复一次；历史投影哈希完全相同，新库主键按阶段转换：`sql-wrapper-final\legacy-preservation.json`。
- 两个HTTP来源库独立以anon请求各完整运行，均exit0：复合冲突键、RLS/header/跨账本隔离、物理DELETE拒绝、旧epoch拒绝、原子清空和receipt；reconcile基线漂移拒绝→重新预览成功、错误ledger/old epoch拒绝→修正通过、真实响应丢失后同号重试逐字段保留另一设备后来更新/新增内容、clear后receipt-first不复活旧数据；另包含HTTP clear/PATCH、clear/write与clear/clear并发：`owned-http-final\schema-protocol.log`、`migration-protocol.log`及`results.json`。
- 长事务/锁顺序另由一个anon TCP事务持锁，另一anon PostgREST HTTP请求观察waiting advisory lock；clear→write和write→clear两种顺序均实际验证：`lock-concurrency\results.json`。
- 所有本轮启动的PostgreSQL/PostgREST/proxy及前端测试服务均停止并检查监听端口关闭；凭证只在受限临时文件，不进入证据归档/仓库。

## 文档与交付

- 17份 tracked 差异与218份未跟踪资料去向逐项列出；原main保持原样，按精确清单本地提交。
- 文档链接/锚点检查：26份变更Markdown、117条相对链接/锚点、失败0（最终文档提交前会再核对一次）。
- 规格/质量复审及关闭附录见[EVIDENCE](EVIDENCE.md)。验收凭证已完成F盘持久归档，manifest列256项/757121 bytes且逐份哈希相符；剩余本地精确提交和提交后工作树复核，完成时回填终态。`stability-closeout`分支/工作树与复核证据全部保留。
- 产品源码和 `schema.sql` / prepare / finalize均未更改；本轮变动是文档/规则、独立验收脚本与测试、Vite必要开发工具链补丁。

## 外部人工事项

生产prepare、兼容前端发布、两台构建确认、生产finalize、线上新构建/云环境验证、真实账本、两台目标真机/安装态PWA、营业日与备份恢复演练均未执行；当前授权内标为 out-of-scope/pending。可直接操作步骤、停止条件及预期证据见[人工发布检查表](RELEASE-CHECKLIST.md)。