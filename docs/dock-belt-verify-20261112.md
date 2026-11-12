# 底栏「安全带」改造 · 实测与收尾（2026-11-12）

底栏从「玻璃背景上的 fixed 浮动胶囊」改成 `.app-shell` 的第 4 行（`auto`），
`.app-main` / `.app-main--dock` 的预留 padding 收紧到 `--yh-page-gap`（14px），
`.checkout-dock` 与进货页保存栏改成 `.app-main` 内的 `position: sticky; bottom: 0`。

口径：390×844（iPhone 14 档），`device_scale_factor=2`，`localStorage['yh-sync-disabled']='1'`，
数据 = 6 单 + 12 条进货。相交面积 = 胶囊 rect ∩ 滚动容器 padding box ∩ 可见元素 rect；
另做 21 点 `elementFromPoint` 命中测试（胶囊上的点最顶层必须是胶囊本身）。

## 1. 7 页 × 5 滚动位置：相交面积（px²）

| 页面 | 0% | 25% | 50% | 75% | 100% | 命中异常 |
|---|---|---|---|---|---|---|
| 记账 | 0 | 0 | 0 | 0 | 0 | 0 |
| 进货 | 0 | 0 | 0 | 0 | 0 | 0 |
| 库存 | 0 | 0 | 0 | 0 | 0 | 0 |
| 报表 | 0 | 0 | 0 | 0 | 0 | 0 |
| 更多 | 0 | 0 | 0 | 0 | 0 | 0 |
| 商品管理 | 0 | 0 | 0 | 0 | 0 | 0 |
| 设置 | 0 | 0 | 0 | 0 | 0 | 0 |

改前（同一口径）报表页：0% 64210.1 / 25% 36518.8 / 50% 129308 / 75% 54988.2，
记账页 0% 82059.2 / 25% 20276.6 —— 这就是「内容从胶囊底下穿过」的那条 bug。

`商品管理` / `设置` 是子页，AppShell 里 `{!sub && !editor ? <TabBar/> : null}`，
**不渲染底栏**（DOM 计数 0，`.app-shell` 第 4 行 `0px`），所以这两页的 0 是「无相交对象」。

## 2. 底栏外观（改前 → 改后）

- 胶囊 rect：278×65 @ (56,763) → **278×65 @ (56,763)**（左右各 56px 边距，未变）
- 计算样式逐项相同：`border-radius: 9999px`、`background-image: linear-gradient(rgba(255,255,255,.14), rgba(255,255,255,.08))`、
  `backdrop-filter: blur(24px)`、`box-shadow: 0 8px 32px rgba(0,0,0,.18), 0 2px 8px rgba(0,0,0,.08), inset ...`、`padding: 6px 10px`
- 只有外层「定位壳」变了：`.glass-tab-bar-dock` `fixed + translateX(-50%) + z-index:900`
  → `static`、390×89 @ (0,755)、`padding: 8px 16px 16px`、`z-index:auto`
- 裁剪图 `before-胶囊-裁剪.png` / `after-胶囊-裁剪.png` 结构一致；像素差来自胶囊是半透明毛玻璃，
  背后内容不同（不是外观差异）。

## 3. 最后一行可达性（滚到底，距底栏带顶边 755）

| 页面 | 最后一行底边 | 间距 |
|---|---|---|
| 记账 | 653（结算浮条顶 667 / 浮条底 741） | 14 + 14 |
| 进货 | 741（保存栏底边） | 14 |
| 库存 | 736 | 19 = 14 + 内层滚动容器 4 + 1 |
| 报表 | 740.7 | 14.3 |
| 更多 | 544.2（内容不足一屏，无滚动） | 不适用 |
| 商品管理 | 830 | 到视口底 14（无底栏） |
| 设置 | 830.4 | 到视口底 13.6（无底栏） |

## 4. `.record-actions`（底部动作栏）的结论

- **场景**：只用于整页编辑视图（`app-shell--editor`，开单 / 改单 / 补场次），
  是**页面级**，不在任何 Sheet 内。该视图不渲染底栏（`.glass-tab-bar-dock` 计数 0，
  第 4 行 0px），实测 rect 390×109.7 @ (0,734.3)，与底栏相交 = **null（无对象可相交）**。
- 弹层：打开进货页「今天录入」Sheet，`.glass-sheet-overlay` `fixed; z-index:1000`，
  面板 390×247 完全覆盖胶囊（coversBar=true），弹层内 `.record-actions` 计数 0。
  即「弹层 > 底栏（z-index auto）」，不会出现底栏浮在弹层上。
- **处理**：保持 `fixed`（编辑视图没有底栏可叠；改 sticky 需先解决「文档滚动 + 内容短于一屏
  时把栏顶到视口底」的 flex 生长链，回归面大于收益）。理由已写进 `src/ui/record.css` 注释。

## 5. 进货页保存栏：补掉一处 sticky 误用

`position: sticky; bottom: 0` 的语义是「不许越过滚动视口下沿」，不是「永远贴住下沿」。
该栏的 DOM 后面还有「今天已录」列表，所以滚到底时它停在静止位置：

- 修正前：`bottom=651.8`，距底栏带顶 **103.2px**，保存按钮漂到屏幕中间（fixed 时代它一直贴底）。
- 修正：`.record-actions--above-dock { order: 1 }`（`.page-stack` 是 flex column，排到视觉流最后）。
- 修正后：5 个滚动位置全部 `660..741`，距底栏带顶 **14px**，与底栏相交 **0**。

## 6. 记账页结算浮条

- `.checkout-dock` rect 358×74 @ (16,667)，与底栏相交 **0/0/0/0/0**。
- 滚动中间会盖住可见内容（页脚说明文字）：0% 7846.4 / 25% 8102.4 / 50% 7844.1 px²，
  75% 与 100% 为 0。这是「常驻动作条」的既有设计（改前 fixed 同样：7904.8 / 8160.8 / 7452.4），
  改后整条上移 13px（改前 bottom=754，现在 741），50% 处多 391.7px²。
- 滚到底最后一张卡完整可见（卡底 653，浮条顶 667）。

## 7. Toast / 横向溢出

- Toast：rect 358×73.2 @ (16,72)，`coversBar=false`（底栏带顶 755），在底栏上方。
- `document.documentElement.scrollWidth == clientWidth == 390`：7 页 × 5 位置全为 true。

## 8. iOS 键盘（未实测，判断依据）

`dvh` 与 `fixed` 在 iOS Safari 上都相对 **layout viewport**：软键盘弹出只缩小 visual viewport，
不改变 grid 第 4 行的高度，所以底栏仍贴在 layout viewport 底部 → 被键盘**遮住**，
但不会「浮到键盘上方」，也不会把内容挤走。改前 fixed 底栏同样是键盘下层，行为无回归。
若要让底栏浮在键盘上方，需要 viewport meta 的 `interactive-widget=resizes-content`
（Android Chrome 支持、iOS 不支持），那会带来「聚焦时整页重排/跳一下」——
`src/ui/record.css` 的 `app-shell--editor` 注释已明确禁止锁高重排，故本轮不加。

## 9. 门禁

| 项 | 结果 |
|---|---|
| `pnpm exec tsc --noEmit` | 0 |
| `pnpm test` | 13 文件 / 140 用例全通过 |
| `pnpm build` | 成功（3.07s） |
| `python scripts/e2e-smoke.py` | exit 0 |
| `python scripts/e2e-sync.py` | exit 0（本地假 Supabase） |

## 10. 脚本与证据

- `scripts/dock-belt-20261112/measure.py`：7 页 × 5 位置矩阵 + 外观 + 末行 + 浮条 + Toast + 截图
  （`--phase=after`；`result-after.json`）
- `scripts/dock-belt-20261112/probe_actions.py`：`.record-actions` 场景 / 弹层层级（`result-actions.json`）
- `scripts/dock-belt-20261112/probe_purchase_bar.py`：进货保存栏 5 个滚动位置（`result-purchase-bar.json`）
- `scripts/dock-belt-20261112/debug_geom.py`：几何调试
- 截图：`docs/screenshots/dock-belt/`（`after-<页>-0/100` 14 张 + 胶囊特写/裁剪 + Toast + 探针截图）

复跑（先 `pnpm dev`，注意端口要与 `AUDIT_BASE` 一致）：

```bash
set AUDIT_BASE=http://127.0.0.1:5174/
python scripts/dock-belt-20261112/measure.py --phase=after
```