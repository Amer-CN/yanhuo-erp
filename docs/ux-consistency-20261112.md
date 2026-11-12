# 实现一致性审计（2026-11-12）

> 范围：`src/ui/**` 全部 18 个 tsx（其中 15 个含 `style={{…}}`）+ `src/styles.css` / `src/ui/record.css` / `src/tokens.css`
> 方法：静态 grep + 代码阅读（每条都给 `文件:行号`）＋ Chromium 124 移动模拟 **390×844 / dsf=2 / is_mobile / has_touch / zh-CN** 运行时实测（`scripts/ux-audit-consistency-20261112/probe.py`、`probe2.py`，原始数值见 `runtime.json` / `runtime2.json`）。
> 本次**只读**，未改任何 `src/` 文件。
> 不重复已修项：进货选商品已换 `ProductPicker`、`ProductPicker` 已全屏、库存卡、四字按钮——本文不再列出。

---

## 一、结论（最该先修的 5 条）

| # | 问题 | 一句话理由 |
|---|---|---|
| 1 | **搜索框 3 份手写、2 份没有可访问名，且系统清除按钮未接管** | `ProductsPage.tsx:86-95` / `StockPage.tsx:211-219` / `ProductPicker.tsx:118-126` 同一段 JSX 抄了三遍，占位符分别是「搜商品」「搜商品」「搜商品名」，只有第三处写了 `aria-label`；`::-webkit-search-cancel-button` 全仓无覆盖（实测 `display:block`），WebKit 下会画出系统灰 X。抽一个 `<SearchField>` 一次修完。<br>**> 已修（见第八节）** |
| 2 | **进货页 1×1 隐藏 `<select>` 是无用技术债** | `PurchasePage.tsx:257-272` + `styles.css:977-991`；全仓只有 **1 行** e2e 依赖它（`scripts/e2e-smoke.py:105` 的 `select_option(index=1)`）。改成点开 `ProductPicker` 后即可删除 20 行兼容代码，成本半天以内。<br>**> 已修（见第八节）** |
| 3 | **「选择商品」按钮字号 16px，全站输入框 15px** | `styles.css:948-953` 的 `.picker-trigger { font: inherit }` 把 `.glass-select` 的 `font-size` 覆盖成了继承值；实测 `picker-trigger=16px` / `input.glass-input=15px`（`runtime.json → dateStyles.trigger`）。一行 CSS，但它是「进货页看起来和记账页不是一套」的直接残留。<br>**> 已修（见第八节）** |
| 4 | **`.check-row` 触控高度只有 30px** | `styles.css:365-370` 没有 `min-height`；实测商品表单里 `label.check-row = 348×30`（对比 `label.gift-toggle = 103×44`）。设置页「合并前先导出本机备份」共用同一类名，同样偏矮。<br>**> 已修（见第八节）** |
| 5 | **错误提示三套写法 + 空态两套写法** | 错误：`glass-hint--error`（`kit.tsx:111`）/ `.record-line__error`（`record.css:348`）/ `.glass-status` 承载错误文本（`SyncPanel.tsx:207`）；空态：`<Empty>`（`kit.tsx:140`）vs 手写 `.session-empty`（`RecordPage.tsx:256`、`:283`），且后者与 `RecordPage.tsx:331` 的 `<Empty text="这一场还没记单">` **同一句文案两套实现**。<br>**> 已修（见第八节）** |

---

## 二、A 原生控件逐项

> 判定标准：是否弹出系统 UI（白底列表 / 日历 / 滚轮 / 文件选择器）；颜色是否跟随主题（`color-scheme`）；圆角、字号、内边距是否受控。
> 实测环境：`:root` 有 `color-scheme:dark`（GlassKit），所以原生指示器在 Chromium 里已是白色。系统弹层本身是 OS UI，headless 截不到，只能按平台行为判定——这点在下面每行的「是否弹系统 UI」里如实标注。

| # | 位置 | 控件 | 是否弹系统 UI | 判定 | 改法 | 成本 |
|---|---|---|---|---|---|---|
| A1 | `PurchasePage.tsx:361`（到货日期） | `input[type=date]` | **是**（Android/iOS 弹系统日历，无法定制） | **可接受**。外壳已跟随主题：实测 `h=52 / radius=14px / bg=rgba(255,255,255,.1) / color=#fff`，与旁边 `批号` 文本框逐项相同，仅多一个月历图标（`04-date-input.png`）。且三处都在「批次信息（可选）」折叠区，属低频字段 | 若要做「完全一类」：抽 `DateField`（日期走 3 段滚轮或 `yyyy-mm-dd` 掩码输入 + 自绘日历），三处一起换 | M（0.5–1 人日） |
| A2 | `PurchasePage.tsx:372`（生产日期） | `input[type=date]` | 同上 | 可接受 | 同上 | 同上 |
| A3 | `PurchasePage.tsx:380`（有效期至） | `input[type=date]` | 同上 | 可接受 | 同上 | 同上 |
| A4 | `SettingsPage.tsx:321`（导入备份） | `input[type=file]` | **是**（系统文件选择器，不可定制） | **可接受**。`display:none` + `aria-hidden` + `tabIndex=-1`，用户只能点主题按钮「导入并合并」（`SettingsPage.tsx:310-315`），文案清楚、`accept="application/json,.json"` 限定类型、导入前有统计与确认 | 无需改；只建议在按钮下补一句「选 iPhone/安卓 里收到的 .json 文件」 | 0 |
| A5 | `kit.tsx:819-826`（商品表单·允许砍价） | `input[type=checkbox]` | 否 | **已统一**：`.glass-checkbox`（`styles.css:1449`，`appearance:none`、24×24、选中橙底白勾）；实测 24×24，包在 `<label>` 里有可访问名「允许现场砍价改价」 | 容器补 `min-height:44px`（见 F2） | S |
| A6 | `RecordLineCard.tsx:204-211`（赠品开关） | `input[type=checkbox]` | 否 | **已统一**：同 `.glass-checkbox`，外面 `label.gift-toggle` 实测 **103×44** | 无 | 0 |
| A7 | `SettingsPage.tsx:818-827`（合并前先备份） | `input[type=checkbox]` | 否 | 已统一（同类名）；但**条件渲染**——选择合并文件后才出现，探针无法触发，仅静态确认 | 无（随 F2 一起修高度） | S |
| A8 | `PurchasePage.tsx:257-272`（隐藏值通道） | `select.picker-compat` | 否（1×1、`aria-hidden`、`tabIndex=-1`） | **必须删**（技术债）。实测 `1×1`，用户与读屏都摸不到，但留下一段「旧自动化兼容」的暗代码 | 把 `scripts/e2e-smoke.py:105` 改成先点 `.picker-trigger` 再点商品行，然后删 select + `styles.css:977-991` | S（半天含跑 e2e） |
| A9 | `ProductsPage.tsx:88-95` | `input[type=search]` | 部分：WebKit 原生清除按钮 | **必须改**：`::-webkit-search-cancel-button` 全仓无规则（实测 `display:block / appearance:auto`），深色玻璃框里会出现系统灰 X；且**没有 `aria-label`**，`product` 列表里它是唯一无名控件 | 抽 `<SearchField label="搜商品">` 统一处理：`type="text"` + 自绘清除，或至少覆盖 `::-webkit-search-cancel-button{display:none}` | S |
| A10 | `StockPage.tsx:212-219` | `input[type=search]` | 同上 | 同上（缺 `aria-label`） | 同上 | S |
| A11 | `ProductPicker.tsx:118-126` | `input[type=search]` | 同上 | 结构同上但有 `aria-label="搜商品名"`；清除按钮仍原生 | 同上（收敛后自然统一） | S |

**未发现**：`input[type=radio]`、`[type=range]`、`[type=time/month]`、`<datalist>`、`window.confirm()`（`kit.tsx:641` 注释确认已由 `ConfirmSheet` 替代）。

**结论**：共 11 处原生控件 —— **必须替换 4 处**（A8 隐藏 `<select>`；A9/A10/A11 搜索框的系统清除按钮，其中 2 处还缺可访问名），**可接受 4 处**（A1–A3 日期、A4 文件选择，理由见上），**已统一 3 处**（A5–A7 三个 checkbox，均为 `.glass-checkbox`；A7 为条件渲染）。

---

## 三、B 同一功能两套实现

| 功能 | 实现 1 | 实现 2 | 收敛到哪套 |
|---|---|---|---|
| **选商品** | `ProductPicker.tsx`（记账 + 进货共用） | 无 | 已收敛，不必再动 |
| **搜索框** | `ProductsPage.tsx:86-95`（无 aria-label） | `StockPage.tsx:211-219`（无 aria-label）／`ProductPicker.tsx:118-126`（有 aria-label） | **抽 `kit` 的 `<SearchField>`**，3 处替换 |
| **确认框** | `ConfirmSheet`（`kit.tsx:642`，8 个调用点：`HistoryPage:332`、`ProductsPage:207`、`PurchasePage:529`、`SettingsPage:590/871/885`、`CloseSessionFlow:165`、`SyncPanel:284`） | 无（全仓无 `window.confirm`） | 已统一 |
| **空态** | `<Empty>`（`kit.tsx:140`，19 个调用点） | 手写 `.session-empty`（`RecordPage.tsx:256`、`:283`，`Clock` 22px + `tiny-text` + `link-btn--xs`） | **保留两套但收进组件**：`<SessionEmpty>` 复用 `Empty` 的结构；`RecordPage:331` 的 `<Empty text="这一场还没记单">` 与 `:257` 手写文案重复，必须二选一 |
| **卡片主数字** | `Stat`（`kit.tsx`，`StockPage.tsx:203` 用了） | 手写 `.stat.stat--stock`（`StockPage.tsx:183-215`，注释 `:175` 明说「Stat 不接受 children」） | 给 `Stat` 加 `children/sub` 后删手写；否则下次改 Stat 只会改到一半 |
| **错误提示** | `glass-hint--error`（`kit.tsx:111`、`HistoryPage:336`、`ProductsPage:215`、`PurchasePage:482/536`） | `.record-line__error`（`record.css:348`，只有颜色和字号）／`.glass-status` 直接装错误文本（`SyncPanel.tsx:207`） | 统一到 `glass-hint--error`；`.glass-status` 只做中性说明 |
| **列表行** | `rowProps()`（`kit.tsx:151`，`History:203`、`Products:121`、`Purchase:418`、`Record:346`、`Stock:289`、`More`×3；`ReportPage` 的 4 个列表是只读列表，无 rowProps） | 无手写 `onClick` 的 `<li>`（grep 证实） | 已统一 |
| **加载态** | `PageLoading` 骨架屏（`AppShell.tsx:372`） | 弹层内 busy 文案（`kit.tsx:669` 处理中…／`:751` 保存中…／`RecordEditor:578/585`／`PurchasePage:411`／`SettingsPage:554`） | 场景不同（页面级 vs 按钮级），**可接受**，建议把文案统一成「保存中…」一种省略号 |
| **底部主操作栏** | `.record-actions`（`RecordEditor`×2、`PurchasePage`） | `.checkout-dock`（`RecordPage`×2） | 语义不同（提交栏 vs 常驻合计条），可接受 |
| **表单落库** | `onBlur` 静默落库（`SettingsPage.tsx:183/202/220`，设置项） | 显式「保存」按钮（`kit.tsx:751`、`PurchasePage:411`、`RecordEditor:578/585`） | **保留**（设置项改了就生效、单据要整单校验），但需写进规范：`设置=onBlur`、`单据=按钮` |

---

## 四、C 令牌漂移 Top10

> 全仓 `style={{…}}` 共 **104 处**（`SettingsPage` 38、`AppShell` 11、`ReportPage` 8、`StockPage` 8、`CloseSessionSheet` 7 …）。下面只列「同一组值在 ≥2 个文件重复」或「裸 px 而令牌里已有同值」的前 10 类。

| # | 值 | 出现次数 | 位置（示例） | 建议令牌 | 备注 |
|---|---|---|---|---|---|
| C1 | `margin: 0` | 15 | `kit.tsx:677`、`MorePage:141`、`SyncPanel:113/183`、`PurchasePage:341/397`、`RecordPage:408/412`、`SettingsPage:223/455/594/597/863`、`CloseSessionSheet:167/214` | 抽 `.u-m0`（8 个字的工具类） | 纯重置，不必进令牌，但要类 |
| C2 | `gap: 8` | 9 | `ProductsPage:162`、`ReportPage:310`、`SettingsPage:459/777/841`、`CloseSessionSheet:197`、`ProductPicker:152`、`SyncPanel:147`、`UpdateBar:56` | `--yh-gap-inline`（=8px） | 已有令牌，只是没用在行内 |
| C3 | `marginTop: 10` | 9 | `SyncPanel:112/182`、`PurchasePage:233/349`、`SettingsPage:177/303/439/496/755` | `--yh-gap-card`（=10px） | 同上 |
| C4 | `marginTop: 8` | 7 | `MorePage:85`、`SettingsPage:300/431/493/503/511/550` | `--yh-space-2` | — |
| C5 | `margin: 0` + `marginBottom: 6` | 6 | `ReportPage:75/308`、`SettingsPage:240` | `--yh-gap-tight`（=6px） | 6px 没有的工具类 |
| C6 | **整个徽标内联对象** | 1 处 11 个裸值 | `AppShell.tsx:237-292`：`minWidth:44 / height:44 / gap:4 / padding:'0 8px' / top:2 / right:1 / minWidth:14 / height:14 / padding:'0 3px' / borderRadius:7 / fontSize:9 / lineHeight:'14px'` | `.sync-pill` + `.sync-pill__count` 进 `styles.css`；`fontSize:9` 用到阶梯外（最小 `--yh-text-2xs:11px`） | 顶栏同步按钮，最该抽类的一处 |
| C7 | `fontSize: 11` / `fontWeight: 700` | 1 | `AppShell.tsx:288` | `--yh-text-2xs` / `--yh-weight-semibold` | 700 不在字重阶梯（400/500/600） |
| C8 | `marginTop: 14` | 1（但与令牌同值） | `SettingsPage.tsx:235` | `--yh-page-gap`（=14px） | 唯一 14px 裸值，正好等于令牌 |
| C9 | `padding: '4px 2px'` / `margin: '2px 0'` / `margin: '4px 0'` | 4 | `HistoryPage:314`、`SettingsPage:538/541/544` | `--yh-space-1` / `--yh-space-0-5` | 2px 档只在令牌里 |
| C10 | `marginLeft: 6` / `margin: '6px 0 0'` / `marginBottom: 4` | 3 | `StockPage:379`、`PurchasePage:484`、`CloseSessionSheet:139` | `--yh-gap-tight`（6px）/ `--yh-space-1`（4px） | — |

**不在 Top10 但值得记一笔**：`.picker-trigger` 的 `font: inherit`（`styles.css:948-953`）让按钮继承 16px，与 `.glass-input` 的 `--gl-font-size-base`(15px) 冲突——这是「值漂移」的 CSS 版，比行内样式更容易被忽略。

---

## 五、D 交互模式

| # | 模式 | 证据 | 是否统一 | 结论 |
|---|---|---|---|---|
| D1 | **点整行做什么** | 商品：点行直接打开**编辑**表单（`ProductsPage.tsx:121`）；库存：点行打开批次详情 + 盘亏表单（`StockPage.tsx:289`）；历史 / 记账：点行只看明细（`HistoryPage.tsx:203`、`RecordPage.tsx:346`） | ❌ | **必须统一**。建议：行点击一律「详情」，编辑由详情里的按钮进入。当前商品页一点行就进可改状态，货名/单价一碰就变，是误改来源 |
| D2 | **危险操作** | 不可撤销 → `ConfirmSheet`：删商品 `ProductsPage:207`、删批次 `PurchasePage:529`、删单 `HistoryPage:332`、清空账本 `SettingsPage:885`（三步确认 `:900`）、撤销结账 `CloseSessionFlow:165`、关闭云同步 `SyncPanel:284`；可撤销 → 直接执行 + Toast「撤销」：行内删行 `RecordEditor.tsx:153-169`；恢复类 → 直接执行：`HistoryPage:117`、`ReportPage:775` | ✅（原则一致） | 保留现状，但把这条原则写进设计规范：**不可撤销=确认，可撤销=撤销条，恢复=直接做** |
| D3 | **表单何时落库** | `onBlur` 静默：`SettingsPage.tsx:183/202/220`；显式按钮：`kit.tsx:751`、`PurchasePage.tsx:411`、`RecordEditor.tsx:578/585` | ✅（有原则） | 保留：设置项 onBlur、单据走按钮校验 |
| D4 | **商品列表的筛选能力** | 库存有搜索 + 「缺货」筛选（`StockPage.tsx:224-232`（chip）+ `:38`（状态））；商品管理只有搜索（`ProductsPage.tsx:86`）；选商品弹层有搜索 + 分类 chip（`ProductPicker.tsx:128`） | ❌ | 建议商品管理补分类 chip（与 `ProductPicker` 共用同一组 `CATEGORIES`） |
| D5 | **数量录入** | 记账行 = `stepper`（±44px 圆钮）+ 可输入数量槽（`styles.css:795-830` + `record.css:359`）；进货 = 纯 `input[inputmode=numeric]` + 校验提示（`PurchasePage.tsx:301-324`） | ✅ | 场景不同（行内连点 vs 整批录入），保留 |
| D6 | **结账后反悔入口** | 结果弹层「撤销」（`CloseSessionSheet`）+ 记账页「上一场汇总条」再撤销（`CloseSessionSheet.tsx:211`、`RecordPage.tsx:306-317`） | ✅ | 保留 |

---

## 六、E 文案与单位

### E1 按钮动词（不一致）

| 位置 | 文案 |
|---|---|
| `kit.tsx:751`（商品表单） | 保存 |
| `PurchasePage.tsx:411` | 保存这一条 |
| `RecordEditor.tsx:585` / `:578` | 保存并记下一单 / 只保存 |
| `ProductPicker.tsx`（add 模式） | 完成（回单据） |
| `kit.tsx:645`（ConfirmSheet 默认） | 确定（实际 8 个调用点全部传了 `confirmText`，默认值不会露出——可接受） |
| `RecordPage.tsx` | 记一笔 / 收摊结账 |
| `SettingsPage.tsx:902` | 不清了（保留数据） |

→ **建议**：主按钮统一「动词 + 对象」（保存商品 / 保存进货 / 保存并记下一单）；「完成 / 确定」只用于**关闭流程**（返回上一级），不再表达「提交」。

### E2 错误语气（两套混用）

| 口语派 | 书面派 |
|---|---|
| `没存上：…`（`kit.tsx:735`、`SettingsPage.tsx:170`、`PurchasePage.tsx:187`） | `删除失败：…`（`ProductsPage.tsx:77`、`HistoryPage.tsx:140`） |
| `没记上：…`（`RecordEditor.tsx:309`、`StockPage.tsx:148`） | `导入失败 / 备份失败 / 恢复失败 / 合并失败 / 导出失败：…`（`SettingsPage.tsx:292/376/391/664/958`） |
| `没改上：…`（`ProductsPage.tsx:175`） | `同步失败 / 连接失败 / 撤销失败：…`（`CloseSessionFlow.tsx:66/82`、`SyncPanel.tsx:74/87`、`HistoryPage.tsx:118`、`ReportPage.tsx:775`） |

→ **建议**：统一为「**没 X 上：原因**」（贴近摊主口吻，也让「没真的记上」这件事说得更重）；`失败` 只留给网络类（同步/连接/复制）。

### E3 单位词

- 商品单位来自数据（`unitBase`：挂 / 个 / 支 / 把 / 盒），默认值 `'个'`（`kit.tsx:697/728`，placeholder「个 / 挂 / 支」`kit.tsx:794`）——**正常**。
- 聚合数字用「**件**」：`StockPage.tsx:184`「库存总件数」（注释 `:89` 说明是净件数）。与商品单位混在同一屏，读起来是「件」=「个」=「挂」，有歧义。建议改成「库存总量」或「库存总件数（含各规格）」。**可接受但建议改**。
- 商品计数用「个商品」（`HistoryPage.tsx:224`、`CloseSessionSheet.tsx:116`）。其中 `CloseSessionSheet.tsx:116`「N 个商品账面为负」用「个」修饰商品、`ReportPage.tsx:577` 注释明确提醒「同屏其它行都写「N 个」，这里不能单独写「件」」——说明作者已踩过这个坑。**保持**。

### E4 同一指标两种叫法（必须改）

| 叫法 | 位置 |
|---|---|
| 「库存 N 挂」 | `ProductsPage.tsx:143`、`StockPage.tsx`、`ProductPicker.tsx:200`（`stock > 0` 分支） |
| 「账面 0」 | `ProductPicker.tsx:200`（`stock <= 0` 分支）——**同一个组件里，0 与非 0 用了两个词** |
| 「库存总件数」 | `StockPage.tsx:184` |

→ 统一用「库存」；0 也写「库存 0 挂」（若想表达「可能欠货」另加角标，别换词）。

### E5 数字格式（一致 ✅）

- 金额：全部 `¥{fenToStr(x)}` → 两位小数（`¥25.00`），`db/util.ts` 的 `fenToStr` 统一取整补零；未知用「—」（`ReportPage.tsx:173`、`CloseSessionSheet.tsx:28`）。
- 数量：`qtyToStr(qty, boxQty, unitBase)`，带单位或 `1 箱 20 挂` 形式。
- 未发现「25 元」「25.0」混用。

---

## 七、F 触控与可及性

实测口径：页面加载后遍历 `button, a[href], input, select, textarea, [role=button], summary`，取 `getBoundingClientRect()`，**宽或高 < 44 且父级 `label` 也没补足**才算违例。

| # | 元素 | 实测尺寸 | 是否有扩展 | 判定 |
|---|---|---|---|---|
| F1 | `.check-row`（商品表单「允许现场砍价改价」，`kit.tsx:819`；设置页「合并前先导出本机备份」`SettingsPage.tsx:818`） | label **348×30**，内部 checkbox 24×24 | 无（`styles.css:365-370` 未设 `min-height`） | **必须改**：加 `min-height: var(--yh-touch-min); padding-block: 6px` |
| F2 | `.glass-segmented__item`（进货单位「挂 / 箱」） | **42×44** | 无 | **建议改**：宽度差 2px 能过 WCAG 但视觉更窄；`.glass-segmented__item{flex:1}` 即可 |
| F3 | `select.picker-compat` | 1×1 | 不可聚焦、`aria-hidden`，非交互目标 | 不算违例，但见 A8（删除） |
| F4 | 其余全部页面（记账 / 进货 / 库存 / 报表 / 更多 / 商品 / 历史 / 设置 / 选商品弹层 / 库存弹层 / 历史弹层 / 商品表单） | **0 处** < 44 | — | ✅ |
| F5 | `.link-btn--xs`（「去库存看看」） | 视觉 12px 文字，`min-height: var(--yh-touch-min)`（`record.css:197-203`）+ 负 margin 抵消 | 有 | ✅ |
| F6 | `.glass-toast__action`（撤销） | 高 32px，`::after` 上下各扩 6px → 44（`styles.css:1512` 注释、实测 0 违例） | 有 | ✅ |
| F7 | `.stepper button`（±） | 44×44（`styles.css:809`） | — | ✅ |

### 可访问名

- 图标按钮：主干 9 个页面实测 **0 个**无可访问名（`aria-label` 写得较完整）。
- **2 个例外**：`ProductsPage.tsx:88-95` 与 `StockPage.tsx:212-219` 的搜索框既无 `<label for>` 也无 `aria-label`（`ProductPicker.tsx:124` 有）。占位符不构成可访问名。
- `SettingsPage.tsx:321` 的 file input 是 `aria-hidden` + 隐藏 → 正确；请确保入口按钮文案「导入并合并」不要改成图标按钮。

---

## 八、G 空态对比

| 场景 | 位置 | 图标 | 文案 | 行动按钮 | 一致？ |
|---|---|---|---|---|---|
| 商品列表为空 | `ProductsPage.tsx:104` | Package 24 | 还没有商品 | 「新建商品」 | ✅ 标准 |
| 库存全空 | `StockPage.tsx:252` | Boxes 24 | 还没有商品 | 无 | ⚠️ 与商品页**同文案**、不同页、无行动按钮 |
| 库存搜索无果 | `StockPage.tsx:258` | Search 24 | 没搜到「X」 | 「看全部商品」 | ✅ |
| 缺货筛选后为空 | `StockPage.tsx:269` | Boxes 24 | 现在没有缺货商品了 | 「看全部商品」 | ✅ |
| 商品全部归档 | `StockPage.tsx:279` | Boxes 24 | 商品都归档了，去「更多 → 商品管理」看看 | 无（只给文字指路） | ⚠️ 有指路必给按钮 |
| 销售记录为空 | `HistoryPage.tsx:165` | Receipt 24 | 还没有销售记录 / 这段时间没有销售记录 | 仅当 `range !== 'all'` 时给「看全部」 | ⚠️ 默认无出口 |
| 今天无已结账场次 | `ReportPage.tsx:208` | Sun 24 | 今天还没有已结账的场次 | 无 | ⚠️ 无出口 |
| 报表无场次 | `ReportPage.tsx:295` | PenLine 24 | 还没有场次，记一笔就开始这一场 | 「记一笔」 | ✅ |
| 该场无有效销售 | `ReportPage.tsx:438` | TrendingUp 24 | 这一场还没卖东西 / 没有有效销售 | 无 | ⚠️ |
| 无删除单据 | `ReportPage.tsx:233` | Ban 24 | 没有被删除的单据 | 无 | OK（纯查看） |
| 无临期批次 | `ReportPage.tsx:587` | TriangleAlert 24 | 没有临期批次 | 无 | OK |
| **本场 0 单（卡内）** | `RecordPage.tsx:283` **手写** `.session-empty` | Clock **22** | 还没开张 / 这一场还没记单 | `link-btn--xs`「去库存看看」 | ❌ 手写实现、图标 22 |
| **本场无单据（列表）** | `RecordPage.tsx:331` `<Empty>` | Receipt 24 | 这一场还没记单 | 「记一笔」 | ❌ 与上行**同一句文案两套实现** |
| 进货今天无记录 | `PurchasePage.tsx:443` | PackagePlus 24 | 今天还没录进货 | 无 | OK（弹层内） |
| 开单草稿里没商品 | `RecordEditor.tsx:424` | PackagePlus 24 | 还没加商品 | 「添加商品」 | ✅ |
| 历史场次列表为空 | `ReportPage.tsx:956` | CalendarRange 24 | 还没有历史场次 | 无 | OK（弹层内） |
| **账本打不开（错误态）** | `AppShell.tsx:1027` | Sparkles 24 | 账本打不开：X | 无 | ⚠️ 错误态复用空态组件，且没有「重试」按钮 |
| 选商品无结果 | `ProductPicker.tsx:148` | Search 24 / Package 24 | 没搜到这个商品 / 还没有商品 | 「看全部」/「去建商品」 | ✅ 最完整的一套 |
| 全局无商品（更多页） | `MorePage.tsx:146` | Package 24 | 还没有商品，先去商品管理建几个 | 无（下一行就是入口行） | OK |

**结论**：结构最完整的是 `ProductPicker`（图标 24 + 文案 + 按钮）；`RecordPage` 是唯一出现「同一文案两套实现 + 图标尺寸 22」的页面；`StockPage:279`、`HistoryPage:165`、`ReportPage:208/438` 缺行动按钮。

---

## 九、建议的修复批次

> 原则：同一文件不得并行改（会互相覆盖）。下表按文件聚合；标 🔒 的文件被多批引用，必须串行。

### 批 1 · 一行级修正（S，约 2h，可并行 4 个 owner）

| 文件 | 改动 |
|---|---|
| `src/styles.css` 🔒 | ① `.picker-trigger` 去掉 `font: inherit` 的字号副作用（显式 `font-size: var(--gl-font-size-base)`）② `.check-row { min-height: var(--yh-touch-min); padding-block: var(--yh-space-1) }` ③ `.glass-segmented__item { flex: 1 }` ④ 补 `input[type='search']::-webkit-search-cancel-button { display: none }` |
| `src/ui/kit.tsx` 🔒 | 新增 `SearchField`（label + 清除按钮 + `aria-label`） |

### 批 2 · 技术债清理（S，需在批 1 之后，因为都动 `styles.css`）

| 文件 | 改动 |
|---|---|
| `src/ui/pages/PurchasePage.tsx` | 删除 1×1 `<select class="picker-compat">`（`:257-272`） |
| `src/styles.css` 🔒 | 删除 `.picker-compat` 规则（`:977-991`） |
| `scripts/e2e-smoke.py` | `:105` 的 `select_option` 改为「点 `.picker-trigger` → 点商品行」 |

### 批 3 · 搜索框收敛（S，依赖批 1 的 `SearchField`；3 个页面文件互不冲突可并行）

`ProductsPage.tsx:86-95`、`StockPage.tsx:211-219`、`ProductPicker.tsx:118-126` → 改用 `<SearchField>`。

### 批 4 · 错误提示与空态统一（M，约 1 天）

| 文件 | 改动 |
|---|---|
| `src/ui/kit.tsx` 🔒 | `ConfirmSheet`/表单统一走 `glass-hint--error`；`Empty` 增加 `size` 约定（24） |
| `src/ui/record.css` | 删除 `.record-line__error`，改用 `glass-hint glass-hint--error` |
| `src/ui/SyncPanel.tsx` | `:207` 的 `glass-status` 错误改为 `glass-hint--error` |
| `src/ui/pages/RecordPage.tsx` | `.session-empty` 两处（`:256`、`:283`）改用 `Empty`；删掉 `:331` 与 `:257` 的重复文案之一 |

### 批 5 · 行语义与列表能力（M，约 1 天）

| 文件 | 改动 |
|---|---|
| `src/ui/pages/ProductsPage.tsx` | 行点击改为「详情」，编辑放到详情里的「编辑」按钮（与 D1 一致）；补分类 chip |
| `src/ui/pages/StockPage.tsx` | 与上一条对齐行语义；`:279` 空态补「去商品管理」按钮 |
| `src/ui/kit.tsx` 🔒 | `Stat` 支持 `children/sub`，删 `StockPage.tsx:183-215` 的手写 `.stat--stock` |

### 批 6 · 令牌化（M，纯样式，建议单独一次 commit）

`styles.css` + `AppShell.tsx:237-292`（抽 `.sync-pill` / `.sync-pill__count`）→ 逐条替换 C1–C10 的内联值。

### 串行约束

```
批1 ──> 批2 ──> 批3
        └────> 批4 ──> 批5
                          └──> 批6
```

- 🔒 `src/styles.css`：批 1 → 2 → 4 → 6
- 🔒 `src/ui/kit.tsx`：批 1 → 4 → 5
- `ProductsPage.tsx`：批 3 → 5（同一文件必须串行）
- 批 4 与批 5 之间无文件冲突，可并行；批 3 与批 4 可并行（不同文件）。

### 不建议改的（纯审美偏好）

1. 日期控件换成自研滚轮（A1–A3）——成本 M、收益低，先把批 1–5 做完再评估。
2. 进货数量改成 `stepper`（D5）——整批录入场景下连点 50 次更糟。
3. `.glass-toast__action` 32px + `::after` 扩展——已满足 44px，不重做。
4. `SettingsPage` 的 38 处内联样式——大多是一个卡片内的局部排版，硬抽组件反而增加间接层；只做 C1–C10 的令牌替换。

---

## 附：产物索引

- 报告：`docs/ux-consistency-20261112.md`（本文）
- 截图（390×844）：`docs/screenshots/consistency/` — `01-record` / `02-purchase` / `03-purchase-dates` / `04-date-input`（日期控件放大）/ `05-stock` / `06-report` / `07-more` / `08-products`（搜索框）/ `09-history` / `10-settings` / `11-settings-file` / `13-product-picker` / `14-record-line` / `15-picker-measured` / `16-record-with-order` / `17-stock-sheet` / `18-report-with-order` / `20-history-sheet` / `21-product-form`（复选框）/ `22-today-purchase-sheet`
- 运行时原始数值：`scripts/ux-audit-consistency-20261112/runtime.json`、`runtime2.json`
- 探针脚本：`scripts/ux-audit-consistency-20261112/probe.py`、`probe2.py`、`count_inline.py`（均只读，不进构建）

---

## 八、修复落地（2026-11-12）

| # | 项 | 落地位置 | 实测 |
|---|---|---|---|
| 1 | 搜索框抽 SearchField | kit.tsx:167；styles.css:1537-1585；三处调用 ProductsPage:94 / StockPage:211 / ProductPicker:117 | aria 3/3；系统灰 X 已消失（A/B 对照 03c/03d） |
| 2 | 删隐藏 select | PurchasePage.tsx:251；styles.css `.picker-compat` 已删；e2e-smoke.py:107 改点 `.picker-trigger` | grep 0；e2e exit 0 |
| 3 | picker-trigger 字号 | styles.css:959 | trigger 15px / input 15px，高均 52 |
| 4 | check-row 触控高 | styles.css:371 | 348×44 |
| 5 | SyncDot 抽类 | AppShell.tsx:233-256；styles.css:1587-1641；tokens.css:172-173 | 内联裸值 0 |
| 6 | 空态/错误提示统一 | RecordPage.tsx:259/287；SyncPanel.tsx:208；record.css:353 | 空态文案 1 处；错误色值/字号一致 |
| 7 | 商品行编辑提示 | ProductsPage.tsx:152；kit.tsx:815 | 标题「编辑商品 / 新建商品」 |

剩余已知：`RecordLineCard.tsx` 的 `.record-line__error` 保留类名（不在本轮改动清单），已由 `record.css:353` 与 `glass-hint--error` 逐项对齐色值/字号。
