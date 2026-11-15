# 烟花进销存

**线上地址（手机装到桌面就是这个）：<https://amer-cn.github.io/yanhuo-erp/>**

自用工具。两个人、两台手机/平板、摊位断网也能开单、联网自动同步。

- 项目路径：`F:\AIXM\烟花爆竹`
- 需求定稿与技术方案：[`docs/01-需求与设计.md`](docs/01-需求与设计.md)
- 出问题先看：[`docs/08-运维手册.md`](docs/08-运维手册.md)（含给摊主的三步恢复卡）
- 上游参考（只读）：`E:\测试\.work\rea-full\` 金蝶 K3Cloud 逆向资产 —— **只借字段语义，不抄代码**

## 状态

**当前工作分支交付状态：本地整合、门禁与独立真实协议验收通过，生产/目标真机待人工执行。** 修复交付从 `0953a9e` 基线完成编辑目标、同步队列、订单完整性、恢复/重连、事务清云与 PWA 更新；本轮从 `b738634` 安全整合旧资料与工具链补丁。候选尚未部署，既有线上地址不代表已包含这些修复。

最终测试数量、覆盖率、E2E 结果和未完成项统一记录在[稳定性修复总方案的最终验收记录](docs/superpowers/plans/2026-11-13-stability-repair.md#最终验收记录2026-11-15)。本机真实 PostgreSQL/PostgREST HTTP、多连接验收已分别留证；mock/fake-indexeddb/WASM 各有自己的验证范围，均不能代替生产或两台目标真机。本轮不 push、不部署、不操作生产账本；将来执行顺序见[人工发布检查表](docs/stability-closeout/RELEASE-CHECKLIST.md)。

以下是原有功能与历史里程碑，不能作为候选发布凭证：

- [x] 交接文档阅读 + 资产核对
- [x] 需求定稿（12 项）
- [x] 技术栈落地（React + TS + Vite + Dexie + PWA）
- [x] M1 骨架 + 商品/进货/库存
- [x] M2 开单 + 日结
- [x] M3 报表
- [x] M4 双设备同步（手动导出/导入 + Supabase 自动云同步，E2E 已验证）
- [x] PWA 离线（E2E 已验证断网刷新 + 断网开单）
- [x] 设计评审（Nielsen 22/40）并完成 P0×2 / P1×3 / P2 十余项修复
- [x] 无障碍回归（标签关联 / 弹层焦点 / Esc / 键盘行 / 44px / 减动效）
- [x] 云同步：Supabase 主账 + 本地发件箱，离线开单、联网自动推拉；内置配置默认开启。恢复后需预览差异再重连，账本切换和清云依赖远端协议能力（见[云同步设置](docs/03-云同步设置.md)）
- [x] 既有版本上线与历史验证（GitHub Pages HTTPS、PWA 安装及历史双设备同步；本轮候选未部署、未做真机复验）
- [ ] 真机摊位上跑一遍（等你俩春节前实际使用）

## 开发

```bash
pnpm install
pnpm dev          # 开发服务器 http://localhost:5173
pnpm build        # 生产构建到 dist/
pnpm preview      # 预览生产构建 http://localhost:4173
pnpm test         # 数据层与同步回归；最终数量见稳定性修复总方案
```

> ⚠️ 不要把 `vite dev` / `preview` 暴露到公网或不可信局域网；launch-editor 相关漏洞可在 dev 进程被利用。默认只监听 `127.0.0.1`；真机联调需要局域网时，临时 `pnpm dev --host` 覆盖，用完即关。

端到端测试（需要 Playwright + Chromium）：

```bash
pip install -r scripts/requirements.txt
python -m playwright install chromium

# 先在两个终端分别启动 loopback dev(5173) 与 build 后的 preview(4173)
pnpm dev --host 127.0.0.1 --port 5173
pnpm preview --host 127.0.0.1 --port 4173

python scripts/check-default-sync.py
python scripts/e2e-smoke.py
python scripts/e2e-sync.py      # 默认本地假 Supabase
python scripts/e2e-offline.py
python scripts/e2e-stability.py --base http://127.0.0.1:4173/
SYNC_RECOVERY_BASE=http://127.0.0.1:4173/ python scripts/e2e-sync-recovery.py
MERGE_BASE=http://127.0.0.1:4173/ python scripts/e2e-merge.py
SHEET_BASE=http://127.0.0.1:4173/ python scripts/e2e-sheet-keyboard.py
PAGE_RECOVERY_BASE=http://127.0.0.1:4173/ python scripts/e2e-page-recovery.py
python scripts/e2e-ui-edge.py --base http://127.0.0.1:4173/
STABILITY_BASE=http://127.0.0.1:4173/ python scripts/e2e-sync-help.py
python scripts/e2e-update.py --dist dist  # 自建 4184 fixture；需要现有 build
python scripts/a11y-check.py
```

以上环境变量写法用于 Bash/CI；PowerShell 写法及证据目录注意事项见[运维手册](docs/08-运维手册.md#12-本轮候选的本地门禁与交付边界)。

PR 与 main 部署共用 [E2E action](.github/actions/e2e/action.yml)：保留 build、dev/preview、smoke/sync/offline 和零配置拦截；新增稳定性、恢复、合并、键盘、页面恢复、UI 边界、SQL 帮助与 PWA 更新为阻塞步骤；a11y 仍处观察期。实际 SQL/RLS、PostgREST HTTP 和多连接并发需要独立环境，按运维手册另行执行；普通 CI 不把缺环境跑成失败或 skip，也不将其记作已验收。

[`docs/screenshots/ui/`](docs/screenshots/ui/) 保存 2026-11-08 的 v1 历史截图（含购物车、结算和找零），不代表当前「记一笔」界面；当前操作以[使用说明](docs/02-使用说明.md)为准。

## 界面

- 设计系统：[GlassKit](https://github.com/JUNGHERZ/GlassKit) v1.40（iOS 26 Liquid Glass，纯 CSS，MIT）
- 图标：[lucide-react](https://github.com/lucide-icons/lucide)
- 深色极光背景 + 半透明玻璃卡片 + 悬浮胶囊 Tab Bar（液滴选中动画）
- 右上角 🌙/☀️ 一键切换深色 / 浅色

## 红线

1. 不复制金蝶反编译代码 / DLL / 资产进本仓库。
2. 不在 `E:\测试` 里干活（那是并行项目）。
3. 跨盘引用一律绝对路径。
4. 不删 `E:\测试\.work\rea-full` 的 `reports/`、`*.jsonl`、`tools/`。