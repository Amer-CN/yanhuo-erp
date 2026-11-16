# 轻玻璃精修 A · 2026-11-16

轻玻璃 A 的实现与验证记录。视觉基线为 0953a9e；发布时整合最新 main，线上状态以 GitHub Actions 的 Deploy to GitHub Pages 流水线为准。

正式入口：https://amer-cn.github.io/yanhuo-erp/

## 变化

- 保留烟花橙与胶囊导航，减轻背景光晕、描边和内高光。
- 次要按钮采用中性玻璃面和主题文字；主操作仍为橙色，缩小投影并保证深色文字对比。
- 卡片内部列表和统计块去掉重复表面投影，金额与内容更清楚。
- 本场金额随屏宽在 24–30px 变化，流水金额右对齐且使用等宽数字。
- 组件库接入现有中文系统字体；常规输入至少 16px。
- 320px 报表遇长金额时收紧横向间距，保持排序按钮 44px 与吸顶表头。

业务逻辑、数据模型、离线同步、文案与页面操作步骤均未改。

## 验证

- pnpm build：通过。
- pnpm test：13 文件，140 测试通过。
- python scripts/e2e-smoke.py：开单、进货、库存、报表、商品和设置通过。
- python scripts/a11y-check.py：标签、焦点、Esc、键盘行、触控和减动效检查通过。
- Python Playwright：两主题 × 320/390/768/1440 宽度 × 记账/库存/报表/进货，共 32 组；长金额 123456.78；未发现页面横向溢出、导航遮盖、金额与结账按钮重叠、可见小按钮或常规输入不足 16px。
- 橙色按钮深墨文字对比：渐变端点 7.33:1 / 5.42:1。
- Impeccable 机械扫描 src/ui：返回空数组；不代表完整无障碍认证。
- 独立只读代码审查：无新增 Critical / Important；底栏光晕规则未命中子 SVG 的 Minor 已改为组件库令牌。

所有浏览器使用隔离数据并禁用真实云同步。桌面 Chromium 验证不代替 iOS 键盘、安全区和真实触感验收。

## 查看

- 本地界面：http://127.0.0.1:5173/
- 前后对照：http://127.0.0.1:5173/docs/screenshots/light-glass/compare.html
- [离线打开前后对照](screenshots/light-glass/compare.html)
- [深色对照图](screenshots/light-glass/compare-dark.png)
- [浅色对照图](screenshots/light-glass/compare-light.png)

## 实现边界

源文件仅修改 src/tokens.css、src/styles.css、src/ui/record.css，无新增依赖。没有重构结构，本轮不改代码异味基线。
