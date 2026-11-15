# 本轮最终验收凭证索引

所有日志/审计 JSON 中含文件系统中的机器路径与测试账本ID，不含生产凭据。生产/目标设备没有被连接。完整可机器复核的test project 副本与测试数据放在隔离 `E:\Temp`，其中测试-only anon/DB凭据不复制到交付档案。原 main 全资料已另在 `F:\AIXM\烟花爆竹-closeout-evidence-20261115`逐项SHA保全。

## 核心与兼容矩阵

验收资料已持久归档到 `F:\AIXM\烟花爆竹-closeout-evidence-20261115\closeout-run`：manifest.json 列256份原始日志/JSON/审查报告/复现脚本，共757121 bytes；逐文件复制与SHA校验一致。归档前扫描已知本地测试凭据及内置anon/ledger值的原文、UTF16、Base64和URL形式，未命中；不复制私有配置、数据库或运行时。当前源日志仍保留在下述E盘根。原235份遗留资料的独立manifest已存在于F盘主保全根。Node22临时pnpm虚拟store复用了预先存在的 `E:\.pnpm-store\v11` 内容寻址缓存，未更改全局npmrc/PATH；该缓存可能有新增cache对象，未删除或清理。Node22源副本只位于E:\Temp并在 `project-final-manifest.json`逐文件SHA。

最终工作树的权威命令出口矩阵：`E:\Temp\yh-closeout-20261115\core-final\core-gates.json`。顺序命令与实际日志：frozen install、tsc、lint、test:cov、build、Python unittest、diff check、npm prod audit、npm全依赖audit。

- Node24.22.1/pnpm12.3.4：331例、0 skip；line90.86%, branch85.58%, function92.62%; `sync.ts` line88.81%; lint0/30; build25 precache entries 890.54KiB。HTTP-only配置收紧后，Python全量17/17再次通过，见 `python-closeout-final.log`；旧配置变体在HTTPS subcase真实失败，见 `protocol-http-only-red.log`。
- Node22.22.1/pnpm12.3.4：同源独立副本 SHA manifest `E:\Temp\yh-closeout-20261115\node22\project-final-manifest.json`；frozen install、`pnpm exec tsc --noEmit`、lint、coverage331/0 skip（lines91.42%、branches85.67%、functions92.92%、sync lines88.81%）、build全部exit0，记录在 `node22\final-clean-results.json`。独立运行时官方归档SHA在 `node22\runtime.json`，仅解压到Temp，没有更改系统Node。
- 固定产物14组脚本、0 skip及src/supabase/dist前后哈希相同：`browser-final\results.json`。只改了临时wrapper隔离输出文件，不改断言/选择器/产品源码。
- 官方npm registry audit：Vite6.4.5；prod0；full 0 High / 5 Moderate / 1 Low，full审计exit1如实保留。完整建议与剩余包公告：`dependency-audit\dependency-audit-report.json` 与 `remaining-findings-after.md`。Vite6.4.4为拒绝的中间态，不计最终通过。
- 新增3条 real Dexie protocol guard有mutation RED证据：`coverage-guards\red-wrong-id.log`、`red-unconfirmed.log`、`red-unknown.log`、`red-wal-fallback.log`；最终coverage gate同步验证。新增SQL pre-connect配置验收有`sql-preconnect-red.log`、`sql-password-red.log`及`sql-preconnect-final.log`。

## 独立本机服务

- 官方归档下载来源、大小与SHA、DB创建、角色/端口/启动命令证据：`portable-db\README-evidence.md`、`download-archives.json`、`service-state.json`。state是服务启动时快照，不应当作stop后实时状态。服务最终停止证据以 `owned-http-final\stopped.json`为准。
- 真实 psql TCP/schema与迁移安装fixture和9种negative entry guard：`sql-real-final\results.json`、每步骤 stdout/stderr日志；所有fixture rollback后专用ledger行数0。
- 连接前 wrapper19命令绿，encoded `%68ostaddr`阻止spawn；历史PRIMARY KEY(id)库prepare/finalize并重复后历史行MD5不变：`sql-wrapper-final\results.json`、`legacy-preservation.json`、`stopped.json`。脱敏libpq v16.16真实本机解析：`review-spec\libpq-parse-evidence.txt`及SHA。
- Actual anonymous HTTP，受控`authenticator`显式SET anon、RLS不旁路：`owned-http-final\schema-protocol.log`和`migration-protocol.log`两路exit0，`results.json`。
- 两种PostgreSQL transaction lock竞争由独立owner psql runner观测，首事务持锁未提交期间第二HTTP blocked：`lock-concurrency\results.json`，附两组pSQL日志。全部服务端口在最终state里Closed。

## 审查与原资料

- 原始审查：`review-spec.md`、`review-quality.md`。独立关闭附录：`review-spec-final.md`（原HTTP状态Important关闭，归档/提交待实际落地）、`review-quality-final.md`（HTTP-only Minor关闭，4个测试方法通过）。原报告保留原貌，附录与最终提交/归档凭证合读；不把生产/真机称为通过。整合提交为 `79604c4779cabf5fe30a82b3e4acff173f4e36b5`，精确38项文件清单、归档校验和提交后复核记录保留在同一F盘保全根的 `closeout-receipt` 补充目录；不改写既有256项验收档案。
- 原main原始tracked patch和所有235逐字节副本：`F:\AIXM\烟花爆竹-closeout-evidence-20261115\tracked.patch`、`manifest.json`、`tracked`、`untracked`。本机全量哈希复核 `preservation-check.json`。
- 完成态机器去向表：[legacy-manifest.json](legacy-manifest.json)，说明：[LEGACY-INVENTORY.md](LEGACY-INVENTORY.md)。所有历史脚本/截图只留档，不直接复跑。

## 当前环境访问/安全异常记录

PostgREST服务首次被一个owner runner启动，之后运行约22分钟遭到外部统一终止（含PostgreSQL checkpointer异常），不是协议断言失败；重启后由唯一owner runner使用进程内本地DLL路径完成两安装库HTTP验收并clean stop。
临时连接配置在创建时使用受限DACL；管理员权限异常使第一次dot-source被拒。操作员停止所有配置写入后，只对connection-env、credentials和两份本地PostgREST配置文件精确添加当前账号FullControl，未更改其他用户/目录；该 ACL修复在本地验证后HTTP通过。该ACL状态属机器本地限制，不作为项目安装要求。测试secret未写入提交/证据正文，档案不收录credential JSON/env脚本。