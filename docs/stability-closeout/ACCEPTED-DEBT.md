# 未清零债务与人工边界

截至2026-11-15。这里仅列真正未清零的项目及完成条件；现役实现/验收主索引为[总方案](../superpowers/plans/2026-11-13-stability-repair.md)。本表不代替任务、提交或现场凭证。

| 类别 | 当前状态 | 后续动作与验收 |
|---|---|---|
| 历史结构 Minor A6/A8/C8/E9/E10 | 已接受，保持现状 | 仅在业务需要或重构另立授权时处理；不为清零统计顺手重构。C8虽与成本报告相关，仍是独立排序重复 |
| 大账本性能 M-001/M-006/M-008 | 已接受性能债，未处理 | 未来以有代表性的至少1万行账本设基准、先有可复现性能失败/目标，再单独实施与验收 |
| 重构保留项 N1/N3/N4 | 已评估，保持现状 | 相关规则变更时重新评估；不扩大本轮范围 |
| 开发依赖 Moderate | audit剩5 Moderate | 属dev tooling findings，逐条评估风险、兼容范围并分别验证；不可用无根据override压低计数 |
| 开发依赖 Low | audit剩1 Low：deepmerge 4.3.1，advisory无patched version | 监视上游/父依赖修复；没有兼容修补或新证据前不添加未经验证override |
| CI平台部署验证 / 线上新build | 本轮未push/deploy、未观察GitHub Actions或线上CDN | 获授权维护者发布后记录CI headSha、部署产物与用户入口build；普通本地browser测试不替代远端发布证据 |
| `callback + release` 双失败独立注入 | 原总方案记录的测试缺口仍在 | 单独设计可确定失败的真实控制器场景，先mutation RED再实现绿；不等同已修产品缺陷 |
| 协议响应丢弃代理 | 当前只支持 loopback HTTP，validator已同步拒绝HTTPS；非业务协议缺陷 | 若未来需要 HTTPS 本机验证，再单独设计证书校验正确的故障代理与配置测试；不以关闭TLS校验支持HTTPS |
| B01 gate release前未提交断言 | 低风险工具债，未包含本轮 | 后续定点加防护时保留既有gate结构/正向运行，证明release前状态受约束 |
| 建商品异步核验窗口第二次取消 | 已记录前端边界 Minor，草稿仍保留 | 出现用户影响或新失败回归再处理，不在本轮改产品 |
| 生产迁移 / GitHub发布 / 线上build / 生产HTTP | 本轮明确 out-of-scope，未做 | 只按[人工发布检查表](RELEASE-CHECKLIST.md)操作；两台备份、独立验收、prepare、兼容前端、两台确认、finalize、生产核对，需授权维护者留存实际证据 |
| 两台目标真机、安装态PWA、营业日、恢复 | pending | 两台候选同build，在独立测试账本完成表中矩阵；营业日对账和导出/隔离恢复通过前不得称真机稳定版 |

本轮已新增并验证 `finishClearOperation` 的错误operationId、pending/unknown拒绝和 write-ahead IDB失败不得发 destructive RPC 三项真Dexie护栏；这三项不再列为缺口。`callback + release` 双失败注入和旧B01 gate提交时序断言仍是本表所列的独立测试缺口；真实HTTP/多连接证明的是服务端协议与锁序，不能据此宣称这两个客户端故障组合已覆盖。
