# 真机尺寸实测报告 · 2026-11-11

- **任务**：34 · `selfcheck_runtime`（390×844 真机尺寸，Playwright 实际点选）
- **执行**：第二棒复测（上一棒在写报告后因环境并发超限崩溃，本轮清理临时目录后**全量重跑**，不复用上一棒结论）
- **基线**：`pnpm build` 通过（vite 2.84s，PWA precache 23 条，`dist/index.html` 16:50:40）
- **测试地址**：`http://127.0.0.1:4173/`（`pnpm preview --port 4173 --strictPort`，本地）——**未访问线上站点，也未连真实 Supabase**
- **红线执行**：每个 context 在首帧前注入 `localStorage.setItem('yh-sync-disabled','1')`（实测读回 `'1'`）；**未修改任何源码**（仅临时脚本 `.work-selfcheck2/`）；未 `git add/commit`
- **结论汇总**：12 项 → **通过 10 / 失败 2（第 4 项、第 9 项）**；a11y 5 段 → **通过 4 / 失败 1（第 4 段触控目标）**
- **收口轮（17:00 构建）更新**：**a11y 5 段已全通过**（第 4 段「知道了」按钮已加高到 ≥44）；**第 4 项已修**（可切箱 + Toast 提示），复测通过；第 9 项仍按断言口径记失败（用户可见行为正常）。详见第五、六节
- **修复后复测（2026-11-11，详见第五节）**：第 4 项 → **已修（允许切箱 + Toast 提示），通过**；第 9 项 → **断言口径问题，非缺陷（实现不改）**；a11y 5 段 → **全部通过（[4] 触控目标 0 个未达标）**
- **与上一棒差异**：上一棒（16:06 构建）第 4 项记为通过；本轮构建（16:50）已包含工作区**未提交**的 M-01 改动（`src/ui/RecordLineCard.tsx` 给「箱」按钮加 `disabled`），第 4 项因此**改为失败**。两次运行脚本与数据相同，差异只来自源码快照不同。

---

## 一、12 项实测结果

| 编号 | 结论 | 实测值 / 断言 | 证据 |
|---|---|---|---|
| 1 添加商品不拉键盘 | **通过** | 打开「选商品」后 `document.activeElement` = `<div class="glass-sheet">`（非 INPUT）；再点搜索框后 = `<input class="glass-input" type="search" aria-label="搜商品名">` | 运行日志：`activeElement={'tag': 'DIV', 'cls': 'glass-sheet'}` / `{'tag': 'INPUT', 'type': 'search', 'aria': '搜商品名'}` |
| 2 数量直接输入 | **通过** | 点数量框 → 直接输 `50` → 值 `50`（点选全选生效，未变成 `150`）；行金额 `1250.00`；标价行 `标价 ¥1250.00 · 让利 ¥0.00`；整单合计 `¥1250.00` = 25.00 × 50 | `docs/selfcheck-shots/01-开单页-数量聚焦.png`；日志 `输入框='50', 行金额='1250.00', 整单合计='¥1250.00'` |
| 3 数量边界 | **通过** | 清空后失焦 → `1`；输入 `0` 后失焦 → `1` | 日志 `清空失焦='1', 输 0 失焦='1'` |
| 4 箱模式换算 | **已修 → 通过** | 修复前：`1挂` 时「箱」按钮 `disabled=True`，切不到箱模式。修复后复测（390×844，17:00 构建）：`箱` 按钮 `disabled=False`；1 挂点「箱」→ 显示 `1`（箱）、标价行 `标价 ¥500.00`（= 25.00 × 20 挂，即 `qtyBase=20`）；Toast「已按 1 箱（20挂）计，可再调整数量」；**点回「挂」数量 `20`（1 箱件数），未回退到旧快照 `1`（H-02 通过）**；箱模式输 `2` → 显示 `2`、金额 `1000.00`，切回「挂」仍为 `40` | `src/ui/RecordLineCard.tsx:143-158`（去 disabled）、`src/ui/useRecordDraft.ts:302-340`（`switchUnit` 返回 `{ok, bumpedToBox}`、`Math.max(1, …)`）、`src/ui/RecordEditor.tsx:286-299`（Toast，仅 `bumpedToBox` 时）；实测见第五、六节；截图 `docs/selfcheck-shots/04-箱模式复测.png` |
| 5 金额点选全选 | **通过** | `selectionStart=0`、`selectionEnd=7`、`value.length=7`（值 `1000.00`） | 日志 `selectionStart=0, selectionEnd=7, len=7` |
| 6 顶栏固定 | **通过** | 列表 `scrollTop=9999`（停在最大 1041）后：`.app-nav.getBoundingClientRect().top = 0`、`window.scrollY = 0` | 日志 `nav.getBoundingClientRect().top=0, position=static, window.scrollY=0, 列表 scrollTop=1041` |
| 7 列表内部滚动 | **通过** | `document.scrollingElement.scrollHeight=844 <= innerHeight(844)+1`；`.stock-page__scroll` `overflowY=auto`、`scrollHeight=1502 > clientHeight=461`；`.app-main` `overflowY=hidden` | 日志同上；`02-库存页-滚动中.png` 可见列表在中间位置、整页未移动 |
| 8 搜索框不被滚走 | **通过** | 列表滚到中部 `scrollTop=521/1041` 时，搜索框 `rect.top=221.3`、`rect.bottom=273.3`（`innerHeight=844`），完整在视口内 | `docs/selfcheck-shots/02-库存页-滚动中.png`（首条可见行非列表首行，搜索框完整可见） |
| 9 弹层锁滚 | **断言口径问题，非缺陷**（实现不改） | 打开前 `scrollTop=400` → 打开后 `400`（`data-locked='1'`、`overflowY=hidden`）；**真实触摸上滑（CDP `Input.dispatchTouchEvent`，从 y=600 上滑到 y=160）后仍 `400`**（手势锁住）；**脚本 `scroller.scrollTop += 200` 后变成 `600`** —— `overflow:hidden` 的容器在 Chromium 里仍保留**程序化**滚动端口，脚本能改、手指不能；关闭后回到 `400`（还原正确） | 日志 `打开前=400, 打开后=400, 触摸上滑后=400（手势锁住=True）, 脚本 +=200 后=600（断言口径不成立）, 关闭后=400`；**判定：断言口径问题，非缺陷，不改实现**（详见「第 9 项判定说明」） |
| 10 删除可撤销 | **通过** | 删除后 `is-voided` 行数=1；Toast 文案 `已删除这笔` 且含「撤销」按钮（Toast 内按钮=1）；点 Toast「撤销」后 `is-voided` 行数=0，行文本与删除前一致（`16:52 · 本机 / 现金 / 1 个商品 / ¥1000.00`） | `docs/selfcheck-shots/03-销售记录-已删除行.png`（红底「已删除」标签 + 行尾「撤销」+ 底部 Toast「已删除这笔 / 撤销」） |
| 11 操作人 | **通过** | 开单页 `.record-page` 全文不含「操作人」，`[aria-label*='操作人']` 控件=0；设置页「本机操作人编号」label 出现 1 次、可访问输入 1 个 | 日志 `页面出现「操作人」=False，aria-label 含操作人的控件=0`；`label 出现 1 次，可访问输入 1 个` |
| 12 主题与状态灯 | **通过** | 顶栏 `.app-nav` 仅 1 个按钮 `aria-label="同步状态：未开启云同步"`，**无主题按钮**；设置页点「切换外观」→ `documentElement.dataset.theme` 由 `dark` → `light` | 日志 `.app-nav buttons=[{'aria': '同步状态：未开启云同步'}]`；`dark → light` |

### 第 4 项补充（修复前的换算佐证，判定已随修复改为通过）

按任务断言「点箱即可切换」记为**失败**。为定位是「换算算错」还是「入口被禁用」，追加一组人工可达路径：数量槽输 `20`（=1 箱）→ 点「箱」→ 显示 `1` → 再输 `2` → 显示 `2`、行金额 `1000.00`、标价行 `标价 ¥1000.00 · 让利 ¥0.00`、合计 `¥1000.00`，**反算 `qtyBase = 1000.00 / 25.00 = 40 = 2 × boxQty`**。
即：**换算与金额正确，问题是入口在「不足 1 箱」时被禁用**（`disabled` 来自工作区未提交的 M-01 改动，`src/ui/RecordLineCard.tsx` 注释写明「不足一箱时禁用（M-01）》」）。用户想「先按箱输入」必须先按挂输满 20 挂，交互上是绕路。

**→ 已修（2026-11-11，见第五节）**：去掉 `disabled`，`switchUnit` 改为「不足 1 箱按 1 箱计」并返回 `bumpedToBox`，由 `RecordEditor` 给一次非模态 Toast。复测：1 挂点「箱」→ 1 箱（`qtyBase=20`，标价 ¥500.00）+ Toast「已按 1 箱（20挂）计，可再调整数量」，再点一次不重复提示。

### 第 9 项判定说明（不改断言，只说明口径）

- 断言「`scroller.scrollTop += 200` 后读回不变」**未通过**（400 → 600）。
- 实现（`src/ui/kit.tsx` `lockBodyScroll()`）：找到主滚动容器后只是打 `data-locked='1'` 并靠样式锁手势，`overflow:hidden` 的容器在 Chromium 里**仍保留程序化滚动端口**，脚本可直接改 `scrollTop`。
- 同轮真实手指上滑（CDP 触摸事件）位置保持 400 不变，关闭后也正确还原到 400 ——**用户可见行为正常**，失败属「断言口径 vs 浏览器实现细节」。
- 结论：按任务要求如实记**失败**；不建议为迎合脚本断言去改实现。

---

## 二、a11y 结果

`python scripts/a11y-check.py http://127.0.0.1:4173/` → **首轮未通过（4 段通过 / 1 段失败）**，修复后复测 **5 段全部通过**（见本节末「a11y 复测结果」）。

| 段落 | 结果 | 明细（脚本原文） |
|---|---|---|
| [1] 标签关联 | ✓ | 选商品搜索框有可访问名；单据字段 `label for=控件 id` 0 个未关联 |
| [2] 弹层焦点与 Esc | ✓ | 有 `aria-labelledby`；焦点在弹层内（`glass-sheet`）；Esc 关闭；关闭后焦点归还「添加商品」 |
| [3] 键盘操作列表行 | ✓ | 更多列表行 Enter 可进入子页（`.back-btn` 存在） |
| [4] 触控目标 | ~~✗ 失败~~ → **✓ 已修** | 首轮：`记账首页无小于 44 的可见控件` → 1 个：`知道了 72x32`。修复后复测：**0 个**（该按钮 72×44，Toast 容器高 78px） |
| [5] 减动效 | ✓ | `prefers-reduced-motion: reduce` 下无残留长动画（0 个） |

**失败定位**：`src/ui/AppShell.tsx` 的 L-10 示例商品一次性 Toast（`showToast('这些是示例商品…', 'warning', { label: '知道了' })`）里的操作按钮实测 **72×32**，短边 32 < 44，手指容易点偏。属本轮新增改动带来的回归，不是旧有问题（上一棒同时刻该段为通过）。

**修法与复测（2026-11-11）**：`src/styles.css:1124-1143` 给 `.glass-toast .glass-toast__action` 加 `min-height: var(--yh-touch-min, 44px)`（纵向抬到 44，横向不强制；关闭按钮 `.glass-toast__close` 同步补成 44 圆）。实测该按钮 `72×44`、Toast 容器 `78px`（< 96px）。

### a11y 复测结果（重建后，2026-11-11）

命令：`pnpm build` → `pnpm exec vite preview --port 4173 --strictPort` → `python scripts/a11y-check.py http://127.0.0.1:4173/`（脚本自带 `localStorage['yh-sync-disabled']='1'` 注入）→ 跑完即关服务。

| 段落 | 复测结果 | 明细（脚本原文） |
|---|---|---|
| [1] 标签关联 | ✓ 通过 | 选商品搜索框有可访问名；单据字段 `label for=控件 id` 0 个未关联 |
| [2] 弹层焦点与 Esc | ✓ 通过 | `aria-labelledby` 存在；焦点在弹层内（`glass-sheet`）；Esc 关闭；关闭后焦点归还「添加商品」 |
| [3] 键盘操作列表行 | ✓ 通过 | 更多列表行 Enter 可进入（`.back-btn` 存在） |
| [4] 触控目标 | ✓ **通过** | `记账首页无小于 44 的可见控件` → **0 个**（修复前 1 个：`知道了 72x32`） |
| [5] 减动效 | ✓ 通过 | `prefers-reduced-motion: reduce` 下无残留长动画（0 个） |

**脚本输出结尾**：`OK：无障碍回归全通过`

---

## 三、失败项复现步骤

### 失败项 A：第 4 项「箱模式换算」（**已修**，2026-11-11；下面保留修复前的复现步骤作对照）

1. `pnpm build && pnpm preview --port 4173`，390×844 打开 <http://127.0.0.1:4173/>。
2. 点「记一笔」→「添加商品」→ 点「大地红 1000 响」（标价 25.00，1 箱 20 挂）→「完成（回单据）」。
3. 在数量槽输入 `1`（或先清空失焦，自动回 `1`），点单位分段里的「箱」。
4. 观察到按钮为禁用态：`disabled=true`、`title="不足 1 箱（当前 1挂，1 箱 20挂）"`，点击无响应，Playwright 直接报 `element is not enabled`。断言「点箱可切换 → 输 2 → qtyBase=2×boxQty」不可达。
5. 对照：先把数量改成 `20`（挂）再点「箱」→ 显示 `1` → 输 `2` → 金额 `1000.00`、qtyBase `40`，换算本身正确。

### 失败项 B：第 9 项「弹层锁滚」的脚本赋值口径

1. 同上启动，点「库存」，让列表可滚（商品 8 个以上）。
2. `document.querySelector('.stock-page__scroll').scrollTop = 400`，点一个完全可见的商品行打开详情（`data-locked='1'`、`overflowY=hidden`）。
3. 控制台执行 `document.querySelector('.stock-page__scroll').scrollTop += 200` → 读回 `600`（断言期望仍是 `400`）。
4. 换真实触摸上滑（`Input.dispatchTouchEvent`）→ 始终 `400`；关闭弹层 → 回到 `400`。

### 失败项 C：a11y [4] 触控目标 `知道了 72x32`（**已修**，2026-11-11）

1. 同上启动，进入「记账」首页（示例商品提示 Toast 会弹出）。
2. `python scripts/a11y-check.py http://127.0.0.1:4173/`，第 [4] 段量到 Toast 上的「知道了」按钮 `getBoundingClientRect()` = `72×32`。
3. 手动复现：记账页等示例商品 Toast 出现 → 量该按钮尺寸即为 72×32（短边 32 < 44）。修法方向：Toast 操作按钮最小高度 44（或 `min-height:44px; padding-block`）。

---

## 四、环境信息

| 项 | 值 |
|---|---|
| Chromium | 149.0.7827.55（Playwright 自带） |
| Playwright / Python | Python `playwright.sync_api`，Python 3.10.11 |
| viewport | `390 × 844`（实测 `innerWidth=390, innerHeight=844`），`is_mobile=True`、`has_touch=True`、`device_scale_factor=3`，`locale=zh-CN`、`timezone=Asia/Shanghai` |
| 服务 | 本地 `pnpm preview --port 4173 --strictPort`（`pnpm build` 后；`dist/index.html` 16:50:40） |
| 同步 | `localStorage['yh-sync-disabled']='1'`（context 初始化注入，实测读回 `'1'`）；顶栏显示「同步状态：未开启云同步」 |
| 控制台错误 | **0 条**（`console.error` / `pageerror` 均无） |
| 源码快照 | 工作区有**未提交改动**（`git status` 约 50 个文件 M），`src/ui/*` 最后修改 16:46–16:49；本轮构建即该快照。复现结论时请确认快照一致 |
| 临时产物 | 脚本与结果 `.work-selfcheck2/`（跑完即删）；截图 `docs/selfcheck-shots/` 3 张（本轮 16:52 刷新） |
| 清理 | 已删除上一棒遗留的 `.work-selfcheck/`（内含 4 个 `.py` 临时脚本、2 个 result json、8 张 smoke 截图，**无源码文件**，已用 `Get-ChildItem` 逐项确认后才删）；`docs/selfcheck-shots/` 保留并覆盖刷新 |
| 源码改动 | **无**；未 `git add/commit` |
---

## 五、修复与复测（2026-11-11 第三棒）

### 修 1：不足 1 箱时「箱」按钮被禁用 → 改为「允许切 + 明确告知」

| 项 | 内容 |
|---|---|
| 问题 | `RecordLineCard.tsx` 给「箱」加了 `disabled`（M-01 那版），`1 挂` 时**切不到箱模式**，必须先手改 20 挂再切 —— 比原来的静默放大更难用 |
| 改法 | ① `src/ui/RecordLineCard.tsx:143-158` 去掉 `disabled` / `aria-disabled` / `title`，恢复可点；② `src/ui/useRecordDraft.ts:302-340` `switchUnit` 返回 `{ ok, bumpedToBox }`，`boxes < 1` 时按 **1 箱**计入；③ `src/ui/RecordEditor.tsx:286-299` 仅在 `bumpedToBox` 时给一条**非模态 Toast**：`已按 1 箱（20挂）计，可再调整数量` |
| 保留的初衷 | 仍然「不静默改写数量」：改写会被明确告知；也不再阻断切换 |
| 只提示一次 | 切到箱模式后，再点「箱」命中「已是目标单位」分支 → 返回 `ok:false`，不再弹 |

**复测日志（390×844，Playwright，本地 preview）**

```
切前 qty(挂)  : 1
切后 qty(箱)  : 1                       ← 显示的是「箱」数
切后 标价行   : 标价 ¥500.00 · 让利 ¥0.00   ← 25.00 × 20 挂，证明 qtyBase=20
toast         : 已按 1 箱（20挂）计，可再调整数量
再点一次 toast: 0                        ← 不重复提示
```

**已知小交互**：应用刚打开 6 秒内，示例商品提示（带「知道了」的 action Toast）还挂着时，这条普通 Toast 会按 M-16 规则被丢弃（`AppShell.tsx:399-406` 有意为之：不让普通提示顶掉可撤销/可操作提示）。数量与金额同时变化可见，故不视为缺陷。

### 修 2：Toast 的 action 按钮 72×32 → 72×44

| 项 | 内容 |
|---|---|
| 问题 | GlassKit 的 `.glass-toast__action` 是 `height:32px`，只靠 `::after` 扩了 6px 可点区，布局盒子仍是 32 → a11y [4] 判失败 |
| 改法 | `src/styles.css:1124-1143`：`.glass-toast .glass-toast__action { min-height: var(--yh-touch-min, 44px); padding-block: 0; }`；`.glass-toast__close` 同步补成 44 圆（仅错误语气出现） |
| 不撑高提示条 | 实测 `Toast 容器高 = 78px`（要求 ≈ ≤96px），只抬高了按钮本体，横向未强制 44 |

### 本轮门禁

| 门禁 | 结果 |
|---|---|
| `pnpm exec tsc --noEmit` | **0 error** |
| `pnpm test` | **12 文件 / 134 通过 / 0 失败 / 0 skip** |
| `pnpm build` | **成功**（PWA precache 23 entries） |
| `python scripts/a11y-check.py http://127.0.0.1:4173/` | **5 段全通过**，`OK：无障碍回归全通过` |

### 本轮改动文件

`src/ui/RecordLineCard.tsx`、`src/ui/useRecordDraft.ts`、`src/ui/RecordEditor.tsx`、`src/styles.css` —— 均未触碰 `src/db/**` 与 `tests/**`；a11y 复测用 `pnpm exec vite preview --port 4173 --strictPort`（跑完已关闭），临时脚本放在仓库外（`E:\Temp\yh-box-check.py`），未新增仓库内文件。

---

## 六、收口验证（2026-11-11 最终）

> 编号说明：任务书原写「第五节」，但第三棒已占用「五、修复与复测」，本轮**独立复跑**的收口验证顺延为第六节。本节数值全部由本轮重新构建（17:00 快照）+ 重新运行脚本得到，不引用第五节的结论。

### 6.1 箱模式复测（390×844 / touch / DPR3，`pnpm build` → `pnpm preview --port 4173`）

前置：开单页数量维护 `1 挂`（大地红 1000 响，标价 25.00，1 箱 = 20 挂）。首次进记账页的「示例商品」提示（带「知道了」action、6 秒生命期）先关掉，避免 M-16 规则吞掉被测提示。

| 步骤 | 断言 | 实测值 | 结论 |
|---|---|---|---|
| B0 初始 | 挂模式、数量 1 | 单位 `挂` `aria-pressed=true`、`箱` `disabled=False`；数量 `1`、金额 `25.00` | **通过** |
| B1 点「箱」 | 可点（非 disabled）、单位切箱、数量 1、Toast 含「已按 1 箱」 | 点击前 `disabled=False`；点击后 `箱 aria-pressed=true`、`disabled=False`，数量 `1`、金额 `500.00`；**Toast `已按 1 箱（20挂）计，可再调整数量`** | **通过** |
| B2 再点「挂」 | 数量回到 1 箱对应件数，**不得**回退旧快照（H-02） | 单位 `挂 aria-pressed=true`；数量 **`20`**（≠`1`）、金额 `500.00`、标价行 `标价 ¥500.00 · 让利 ¥0.00`、合计 `¥500.00` | **通过** |
| B3 箱模式输 2 | 换算 40 挂、金额 1000.00；切回挂仍 40 | 箱模式显示 `2`、金额 `1000.00`；切回挂数量 `40`、金额 `1000.00` | **通过** |
| B4 附注 | 示例提示未关时切箱，说明是否被吞 | 切箱前后 Toast 都是 `这些是示例商品，去「更多 → 商品管理」改成自己的货 / 知道了`，**不含「已按 1 箱」** | 现象**已复现**（M-16 规则有意丢弃普通提示；数量/金额同时变化可见，不判缺陷） |

证据：`docs/selfcheck-shots/04-箱模式复测.png`；控制台错误 **0 条**；`localStorage['yh-sync-disabled']` 实测读回 `'1'`。

### 6.2 a11y 五段（`python scripts/a11y-check.py http://127.0.0.1:4173/`）

| 段落 | 结论 | 脚本输出 |
|---|---|---|
| [1] 标签关联 | **通过** | 选商品搜索框有可访问名；`label for=控件 id` 0 个未关联 |
| [2] 弹层焦点与 Esc | **通过** | `aria-labelledby` 存在；焦点在 `glass-sheet`；Esc 可关；关闭后焦点归还「添加商品」 |
| [3] 键盘操作列表行 | **通过** | 更多列表行 Enter 可进入子页 |
| [4] 触控目标 | **通过**（上一轮失败的 `知道了 72x32` 已修） | `记账首页无小于 44 的可见控件 — 0 个: []` |
| [5] 减动效 | **通过** | reduce 下无残留长动画（0 个） |

汇总行：`OK：无障碍回归全通过`。测完已 `Stop-Process` 关闭 preview，`Get-NetTCPConnection -LocalPort 4173` 确认端口已释放。

### 6.3 三项门禁（本轮真实输出）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm exec tsc --noEmit` | **exit 0，0 error** |
| 单测 | `pnpm test` | **12 个测试文件 / 134 通过 / 0 失败 / 0 skip**（exit 0，1.86s） |
| 构建 | `pnpm build` | **成功**（`✓ built in 2.85s`，PWA `precache 23 entries (759.36 KiB)`，exit 0） |

注：`AGENTS.md` 写的是「127 个用例」，本轮实际 **134**（新增 `tests/sync-inbound.test.ts` 等 7 个用例），文档口径待同步。

### 6.4 清理结果

| 项 | 结果 |
|---|---|
| 临时目录 | `.work-selfcheck2/`、`.work-selfcheck3/` 均已删除；`Get-ChildItem -Filter ".work-selfcheck*"` 返回空 |
| 临时脚本 | 本轮脚本仅存于 `.work-selfcheck3/box_retest.py`，随目录一并删除；仓库内未新增任何脚本 |
| 截图 | `docs/selfcheck-shots/` 保留 4 张：`01-开单页-数量聚焦.png`、`02-库存页-滚动中.png`、`03-销售记录-已删除行.png`、`04-箱模式复测.png` |
| `git status --porcelain` 未跟踪项（`??`） | `docs/review-20261110/`、`docs/selfcheck-data-20261111.md`、`docs/selfcheck-runtime-20261111.md`、`docs/selfcheck-shots/`、`docs/selfcheck-ui-20261111.md`、`docs/ux-review-20261111.md`、`docs/代码审查报告-20261110.md`、`src/ui/ErrorBoundary.tsx`、`tests/sync-inbound.test.ts` —— **均为预期产物（文档 + 新源码/测试文件），无临时文件** |
| 源码改动 | 本轮**未改任何源码**；未 `git add/commit` |
| 已跟踪改动 | 47 个文件 `M`（第三棒及前序批次的重构改动，非本轮产生） |
