# 烟花进销存

自用工具。两个人、两台手机/平板、摊位断网也能开单、收摊合并对账。

- 项目路径：`F:\AIXM\烟花爆竹`
- 需求定稿与技术方案：[`docs/01-需求与设计.md`](docs/01-需求与设计.md)
- 上游参考（只读）：`E:\测试\.work\rea-full\` 金蝶 K3Cloud 逆向资产 —— **只借字段语义，不抄代码**

## 状态

- [x] 交接文档阅读 + 资产核对
- [x] 需求定稿（12 项）
- [x] 技术栈落地（React + TS + Vite + Dexie + PWA）
- [x] M1 骨架 + 商品/进货/库存
- [x] M2 开单 + 日结
- [x] M3 报表
- [x] M4 同步合并（导出/导入，E2E 已验证两设备合并）
- [x] PWA 离线（E2E 已验证断网刷新 + 断网开单）
- [ ] M5 真机部署 / 打包（需要 HTTPS 才能安装离线）

## 开发

```bash
pnpm install
pnpm dev          # 开发服务器 http://localhost:5173
pnpm build        # 生产构建到 dist/
pnpm preview      # 预览生产构建 http://localhost:4173
pnpm test         # 核心计算单元测试
```

端到端测试（需要 Playwright + Chromium）：

```bash
python scripts/e2e-smoke.py     # 开单/进货/报表/库存全流程
python scripts/e2e-offline.py   # 断网可用（先 build + preview）
python scripts/e2e-merge.py     # 两设备导出导入合并（先 build + preview）
```

界面截图在 [`docs/screenshots/`](docs/screenshots/)。

## 红线

1. 不复制金蝶反编译代码 / DLL / 资产进本仓库。
2. 不在 `E:\测试` 里干活（那是并行项目）。
3. 跨盘引用一律绝对路径。
4. 不删 `E:\测试\.work\rea-full` 的 `reports/`、`*.jsonl`、`tools/`。