# 未决事项与人工边界

更新：2026-11-15（Asia/Shanghai）。本地可自动部分已完成。生产与真机事项是授权范围外/pending，不代表产品失败，也不记为本地 skip。

| 事项 | 状态 / 具体原因 | 下一步与验收方式 |
|---|---|---|
| 生产 PostgreSQL/PostgREST / 生产多连接 | out-of-scope；已完成的仅是 E:\Temp 受控 loopback 独立项目副本验收 | 获授权维护者按发布检查表在生产迁移窗口核对 actual roles/claims/API；保留真实环境证据，不用本地结果代替 |
| 开发依赖 High | 已修补并验证：Vite 6.4.5；正式registry audit High=0、prod=0 | 后续仍有开发 Moderate 5 / Low 1，不在本轮扩大升级；Vitest major、glob/minimatch、deepmerge另行评估 |
| 生产 prepare / finalize / 发布 / 生产HTTP | out-of-scope；本轮未授权，也未连接/访问生产 | 只按人工发布检查表操作；生产SQL、线上commit/build与真实云RLS状态须获授权维护者逐项记录，本机loopback证据不能代替 |
| 两台目标真机 / 安装态 PWA / 营业日与恢复 | pending；本机浏览器/独立loopback服务不等价于实际设备和营业日 | 两台同一候选build + 测试账本全矩阵、至少一个营业日对账及隔离备份恢复，由维护者人工记录；详见发布检查表 |

已接受、不扩大本轮范围：历史结构 Minor A6/A8/C8/E9/E10；大账本性能债 M-001/M-006/M-008；N1/N3/N4 维持基线既有判断。准确技术债与历史说明以[异味基线](../代码异味基线-20261110.md)为准。

本机阻碍：无。原 main 全部235份遗留文件已逐字节保全并完成逐项审计，去向见[完整清单](legacy-manifest.json)。上述生产/真机事项均待获授权维护者按[人工发布检查表](RELEASE-CHECKLIST.md)执行；未将其当本地通过或skip。
