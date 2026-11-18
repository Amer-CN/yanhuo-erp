# 轻玻璃精修 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 完成用户选定的 A 方案，降低视觉噪声并突出金额与主操作。

**Architecture:** 在现有设计令牌及应用层 CSS 内实现，不修改组件接口和数据库。由同一组语义值桥接 GlassKit，降低深浅主题漂移。

**Tech Stack:** React 18、TypeScript、GlassKit 1.40、Vite、Python Playwright。

**Spec:** docs/superpowers/specs/2026-11-16-light-glass-design.md

## Global Constraints

- 保留烟花橙、深浅主题、胶囊导航和现有布局模型。
- 只改样式和设计文档；不改变业务、交互步骤或文案。
- 不增加依赖；测试浏览器设置 yh-sync-disabled=1 并阻断真实 Supabase。
- 本次为可逆视觉微调，使用已有回归与真实浏览器测量，不新增断言 CSS 字面值的单元测试。

## Review Focus

- 320px 窄屏与长金额不会挤出按钮或横向溢出。
- 深浅主题正文、占位符、次要按钮及焦点仍清晰。
- 卡内表面收淡后选中、错误、禁用状态仍可分辨。
- 底部动作行与导航仍真实占位，内容不被遮盖。
- 输入框至少 16px；减动效和键盘焦点保持有效。

### Task 1: 视觉基线与令牌

**Files:** src/tokens.css；docs/superpowers/specs/2026-11-16-light-glass-design.md。
**Interfaces:** 既有 --yh-* 及 --gl-* CSS 变量；不新增组件接口。

- [x] 运行已有测试、构建并保存相同数据的改前截图。
- [x] 以语义层为主控降低背景光、描边和高光，将字号、字体及表面桥接给 GlassKit。

### Task 2: 公共表面与排版

**Files:** src/styles.css；src/ui/record.css。
**Interfaces:** 复用既有 class，布局、字号调整不改变事件与业务状态。

- [x] 收淡次按钮、卡内列表和统计块；保持主按钮橙色和触控高度。
- [x] 调整本场金额和列表金额层级，核对长文本、深浅主题、窄屏。

### Task 3: 验证与交付

**Files:** docs/ui-light-glass-20261116.md；docs/screenshots/light-glass/。

- [x] pnpm build、pnpm test、e2e-smoke.py、a11y-check.py。
- [x] Playwright 截图/溢出/触控/对比度测量覆盖两主题和 320/390/768/1440 宽度。
- [x] 完整 diff 审查和独立代码审查，记录证据、预览与真机局限。
