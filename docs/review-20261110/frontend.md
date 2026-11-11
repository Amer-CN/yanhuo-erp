# 前端审查报告（2026-11-10）

> 审查对象：`F:\AIXM\烟花爆竹`（React 18 + TypeScript + Vite 的自用烟花进销存 PWA）
> 审查视角：**前端维度**（正确性 / React 性能 / 状态管理 / 可访问性与交互 / 可维护性）
> 审查性质：**只读审查**，未修改任何源码或样式
> 对照基线：`docs/代码异味基线-20261110.md`——其中「已消除」29 条与「已关闭」2 条**不再重复报告**（A1/A2/A3/A4/A8 体量口径/C7/C9/D1/D3/D5/N1/N3 等一律不重复）；`M-001/M-006/M-008` 属基线仍待办项，本报告只在末尾标注「仍然存在」，不计入新发现。

---

## 一、审查范围

以下文件**逐行读过**（不是片段采样）：

**页面组件（7 个）**
- `src/ui/pages/RecordPage.tsx`（214 行）
- `src/ui/pages/PurchasePage.tsx`（372 行）
- `src/ui/pages/StockPage.tsx`（246 行）
- `src/ui/pages/ReportPage.tsx`（600 行）
- `src/ui/pages/HistoryPage.tsx`（212 行）
- `src/ui/pages/ProductsPage.tsx`（172 行）
- `src/ui/pages/SettingsPage.tsx`（802 行）

**通用组件与 hook**
- `src/ui/kit.tsx`（521 行：Btn / Card / Field / Stat / Empty / rowProps / Toast / Sheet / ConfirmSheet / ProductFormModal）
- `src/ui/useRecordDraft.ts`（309 行）
- `src/ui/recordDraft.ts`（156 行，草稿存取与金额解析，hook 的直接依赖）
- `src/ui/RecordEditor.tsx`（361 行，开单整页，`useRecordDraft` 的唯一消费者）
- `src/ui/RecordLineCard.tsx`（130 行，商品行卡片）
- `src/ui/ProductPicker.tsx`（139 行，选商品弹层）

**入口、路由与壳层**
- `src/main.tsx`（13 行）
- `src/App.tsx`（249 行）
- `src/ui/AppShell.tsx`（685 行：Context / AppMain / TABS 路由表 / AppShell / useToast / useTheme）

**流程与同步 hook（与页面行为强耦合）**
- `src/ui/useSync.ts`（125 行）
- `src/ui/useBoot.ts`（93 行）
- `src/ui/CloseSessionFlow.tsx`（170 行）
- `src/ui/CloseSessionSheet.tsx`（结构核对：确认其为 `Sheet` 实现，用于验证弹层嵌套）
- `src/ui/MorePage.tsx`（169 行）
- `src/ui/UpdateBar.tsx`（66 行）

**样式**
- `src/styles.css`（904 行）
- `src/tokens.css`（264 行）
- `src/ui/record.css`（377 行）

**辅助核对手段**
- `Select-String` 统计：全仓 `ErrorBoundary|componentDidCatch|getDerivedStateFromError` 命中数（0）、各文件 `style={{` 数量、`focus-visible`/`prefers-reduced-motion`/`!important`/裸 px 数量、`<Sheet|ConfirmSheet|ProductFormModal|ProductPicker` 全部使用点（用于验证弹层嵌套）。
- 阅读 `reports/代码检视报告-20261110.html` 中 M-001 / M-006 / M-008 原文，确认哪些属既有待办、避免重复报告。

**未纳入本轮的文件**：`src/db/**`（数据层，另有专项审查）、`src/ui/SyncPanel.tsx` 正文（只在弹层嵌套核对时使用其行号）、`scripts/**`、`docs/**`。

---

## 二、发现列表

### High（1 条）

#### H1
- **级别**：High
- **位置**：`src/ui/AppShell.tsx:262-278`（7 个 `lazy()`）+ `src/ui/AppShell.tsx:378`（`<Suspense>`）；全仓库 grep `ErrorBoundary/componentDidCatch` **0 命中**
- **问题描述**：全应用没有任何错误边界，而 `PurchasePage / StockPage / ReportPage / ProductsPage / HistoryPage / SettingsPage / RecordEditor` 共 7 个页面全部是 `React.lazy` 动态 chunk，只包了一层 `<Suspense fallback={<PageLoading/>}>`。
- **为什么是问题**：只要某个 chunk 加载失败（发版后旧 index.html 引用了已被清理的 chunk、首屏后的 `preloadSecondaryPages`（`AppShell.tsx:270-278`）命中 404、弱网超时），`Suspense` 无法处理「加载失败」，React 会向上抛错；没有错误边界就**卸载整棵树 → 白屏**，摊位上连「记账」都点不进去。`useBoot` 只兜住了 IndexedDB 启动错误（`useBoot.ts:52-54`），这条路径完全裸露。这与「断网不得阻断开单」的产品定位直接冲突：断网本身有 PWA 预缓存兜着，但「发了新版 / 缓存被清 / 预取失败」照样能把账本界面打空。
- **具体修复建议**：在 `main.tsx` 的 `<App/>` 外层与 `AppMain` 内各放一个极简边界（不需要引三方库）：

```tsx
class Boundary extends React.Component<{ fallback: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(e: Error) { return { err: e }; }
  render() { return this.state.err ? this.props.fallback : this.props.children; }
}
```

  外壳层 fallback 给「重新打开」（`location.reload()`）+「导出最近备份」；页面层 fallback 给一张 Card +「重试本页」，保证开单主路径不被其它页面 chunk 连坐。

---

### Medium（11 条）

#### M1
- **级别**：Medium
- **位置**：`src/ui/kit.tsx:247-306`（`Sheet` 滚动锁 + `close()`）；实际触发点 6 处：`src/ui/pages/HistoryPage.tsx:114` 与 `:190`、`src/ui/pages/PurchasePage.tsx:272` 与 `:347`、`src/ui/pages/ProductsPage.tsx:117` 与 `:156`、`src/ui/pages/SettingsPage.tsx:666` 与 `:700`、`src/ui/SyncPanel.tsx:229` 与 `:284`、`src/ui/CloseSessionSheet.tsx:124` + `src/ui/CloseSessionFlow.tsx:159`
- **问题描述**：弹层可以嵌套，但 `Sheet` 的滚动锁不是引用计数的。内层 `Sheet` 挂载时 `body` 已是 `position:fixed`，因此内层 effect 读到的 `window.scrollY` 是 0；内层卸载时 cleanup 执行 `body.style.position=''` + `window.scrollTo(0, 0)`，而此时外层弹层仍然打开。
- **为什么是问题**：用户点「整单作废」/「删除这条进货」/「删除商品」/「撤销合并」时，内层确认框一关，**背景滚动锁被解除且页面被弹回顶部**；随后外层弹层关闭时又按它当时记下的 `savedY` 跳一次。手机上表现为「关掉确认框后列表跳到最上面、还能拖动背景」。这是 `Sheet` 的行为缺陷，**不是**基线 A8 记的「125 行 / 一个 effect」体量问题（那条已评估保留，本报告不重复）。
- **具体修复建议**：抽一个模块级锁定计数器，只有 0→1 才真正锁、1→0 才恢复：

```ts
let lockCount = 0;
let savedY = 0;
// 进入
if (++lockCount === 1) { savedY = window.scrollY; document.body.style.position = 'fixed'; document.body.style.top = `-${savedY}px`; }
// 退出
if (--lockCount === 0) { document.body.style.position = ''; document.body.style.top = ''; window.scrollTo(0, savedY); }
```

  `savedY` 只由最外层记录，嵌套层不再读写 scroll。

#### M2
- **级别**：Medium
- **位置**：`src/ui/kit.tsx:303-306`
- **问题描述**：`close()` 用 `window.setTimeout(..., 260)` 推迟 `onClose`，但**定时器既不清除也没有在卸载时取消**；且 260 与 `--yh-dur-sheet: 260ms`（`src/tokens.css:116`）是同一数值却硬编码。
- **为什么是问题**：① 用户 260ms 内连点遮罩两次 → `onClose` 触发两次，父组件状态被翻转两次；② 父层因别的途径已卸载该弹层时，回调仍会在 260ms 后打到已过期的 intent；③ 开了 `prefers-reduced-motion`（`src/styles.css:884-902` 把过渡归零）后仍固定等 260ms，关闭延迟与动画时长脱钩。
- **具体修复建议**：

```tsx
const closeTimer = useRef<number>();
useEffect(() => () => { if (closeTimer.current) window.clearTimeout(closeTimer.current); }, []);
const close = () => {
  setActive(false);
  if (closeTimer.current) window.clearTimeout(closeTimer.current);
  closeTimer.current = window.setTimeout(() => onCloseRef.current(), 260);
};
```

  更稳的做法是在面板上监听 `transitionend`（过渡已在 CSS 里定义），拿不到事件再用 `setTimeout` 兜底。

#### M3
- **级别**：Medium
- **位置**：`src/ui/pages/PurchasePage.tsx:82-105`（另见 `src/ui/pages/StockPage.tsx:56-76`、`src/ui/pages/ProductsPage.tsx:33-42`、`src/ui/pages/SettingsPage.tsx:532-536`）
- **问题描述**：写库调用是裸 `await`：**没有 `try/catch`、没有 busy、按钮没有 disabled**。受影响：`createBatch`、`createAdjustment`、`createProduct`/`updateProduct`/`deleteProduct`、`clearAllData`。
- **为什么是问题**：抛错时（Safari 存储配额、事务被阻塞、`RecordError` 之外的异常）是 unhandled rejection：**用户看不到任何提示，表单也不清空，但会以为已保存**。进货页尤其危险——同一批货录两遍会直接改写 FIFO 成本；清空数据失败则用户以为已清空。同项目其它地方（`HistoryPage.tsx:123-132`、`SettingsPage.tsx:209-222`）都遵循「写入失败必须如实告知」，标准不统一。
- **具体修复建议**：与其他页对齐，加 busy 与 catch：

```tsx
const [saving, setSaving] = useState(false);
const save = async () => {
  if (saving) return;
  /* …校验… */
  setSaving(true);
  try {
    await createBatch({ /* … */ }, deviceId);
    onDone(`已进货 ${product!.name} ${qtyToStr(qtyBase, product!.boxQty, product!.unitBase)}`);
    resetForm();
  } catch (e) {
    onDone(`没存上：${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    setSaving(false);
  }
};
```

  `Btn` 上加 `disabled={saving}`（文案统一「保存中…」）。

#### M4
- **级别**：Medium
- **位置**：`src/ui/kit.tsx:410-433`（`ProductFormModal.submit`）+ 调用方 `src/ui/pages/ProductsPage.tsx:120`、`src/ui/pages/PurchasePage.tsx:337-342`
- **问题描述**：商品表单的「保存」按钮没有 busy/禁用，`await onSave({...})`（`kit.tsx:425`）也没有 `catch`。
- **为什么是问题**：① 手机连续轻点「保存」会 `createProduct` 两次（同一商品重复入库，之后的库存与成本都会双份，且这类重复很难被觉察）；② `onSave` 抛错时表单既不报错也不关闭，用户只会再点一次，让问题加倍。
- **具体修复建议**：在 `ProductFormModal` 内部持有 `saving`，`Btn disabled={saving}`，并把 `onSave` 的拒绝接到现有的 `err` 状态上：

```tsx
const [saving, setSaving] = useState(false);
const submit = async () => {
  if (saving) return;
  setSaving(true);
  setErr('');
  try { await onSave({ /* … */ }); }
  catch (e) { setErr(e instanceof Error ? e.message : '没存上，再试一次'); }
  finally { setSaving(false); }
};
```

#### M5
- **级别**：Medium
- **位置**：`src/ui/pages/HistoryPage.tsx:195-206`、`src/ui/pages/PurchasePage.tsx:351-366`、`src/ui/pages/ProductsPage.tsx:161-166`、`src/ui/CloseSessionFlow.tsx:164`
- **问题描述**：`ConfirmSheet` 的 `onConfirm` 被写成 `async`（在 `() => void` 类型下被 TypeScript 静默接受），**且都没有传 `busy`**。全项目只有 `SettingsPage.tsx:450` 用了 `busy`。
- **为什么是问题**：`ConfirmSheet` 的 `busy` 本来就是为「处理中禁止重复触发」设计的，其余四处全是「关框 → await → 提示」。双击或手指抖两下就会重复执行：`voidOrder` 第二次抛错后被 `catch` 吃掉，用户只看到「作废失败」；`deleteProduct` 同理。而且框在 `await` 之前就关了，失败提示只能靠 toast，与「失败提示要出现在用户看得见的那一层」的项目经验不一致。
- **具体修复建议**：

```tsx
const [voiding, setVoiding] = useState(false);
const doVoid = async () => {
  if (!open || voiding) return;
  setVoiding(true);
  try { await voidOrder(open.id); onDone('已作废'); setVoidConfirm(false); setOpenId(null); }
  catch { onDone('作废失败，请重试', 'warning'); }
  finally { setVoiding(false); }
};
<ConfirmSheet busy={voiding} onConfirm={() => void doVoid()} /* … */ />
```

  四处的改法一致：成功后才关框，失败时保持框打开并显示原因。

#### M6
- **级别**：Medium
- **位置**：`src/ui/recordDraft.ts:69-75`（`saveDraft` 用 `sessionStorage`），调用方 `src/ui/useRecordDraft.ts:102-119`
- **问题描述**：开单草稿存在 **sessionStorage** 里（`recordDraft.ts` 文件头注释亦写明「自动存 sessionStorage」）。
- **为什么是问题**：sessionStorage 的生命周期是「标签页/进程」，**PWA 被系统回收（安卓/iOS 内存压力下极常见，摊位开单时切微信再回来就可能被杀）后草稿直接消失**。断网不丢单这条红线是守住的（数据提交时落 IndexedDB + outbox），但「记到一半切后台再回来白干」正是草稿功能要解决的场景。而 edit/patch 模式已用 `orderId`/`sessionId` 校验防串单（`useRecordDraft.ts:65-69`），换持久存储不会引入串单风险。
- **具体修复建议**：把 `saveDraft/loadDraft/clearDraft` 三处的 `sessionStorage` 换成 `localStorage`（键已带 `:new` / `:edit:` / `:patch:` 隔离，`draftKey` 无需改），`try/catch` 已就位。注意 `clearDraft` 里 `legacyKeyFor` 的旧键清理也要同步指向 localStorage，否则旧键残留。

#### M7
- **级别**：Medium
- **位置**：`src/ui/RecordLineCard.tsx:58-76`（两个单位按钮都 `onClick={onSwitchUnit}`）+ `src/ui/useRecordDraft.ts:166-183`（`switchUnit` 实现是 toggle）
- **问题描述**：单位分段控件渲染成两个互斥按钮（`aria-pressed={l.unit==='base'}` / `aria-pressed={l.unit==='box'}`），但两个按钮共用一个 **toggle** 处理函数。
- **为什么是问题**：点当前已选中的那一项会**反向切换**——本来按「个」，点「个」会变成「箱」。这与 `aria-pressed` 表达的单选语义直接矛盾，也是可复现的误操作，而且切换后数量会按箱数取整（`useRecordDraft.ts:175` 的 `Math.max(1, Math.floor(l.qtyBase / p.boxQty))`），**用户点错一下数量就被悄悄改写**，在摊位上很难当场发现。
- **具体修复建议**：让卡片显式传目标单位，hook 侧加幂等判断：

```tsx
// RecordLineCard
onSwitchUnit: (unit: 'base' | 'box') => void;
<button aria-pressed={l.unit === 'base'} onClick={() => onSwitchUnit('base')}>{p.unitBase}</button>
<button aria-pressed={l.unit === 'box'}  onClick={() => onSwitchUnit('box')}>箱</button>

// useRecordDraft
const switchUnit = (idx: number, target: 'base' | 'box') => {
  const line = draft.lines[idx];
  const p = productById.get(line.productId);
  if (!p || p.boxQty <= 1 || line.unit === target) return;
  /* 原逻辑 */
};
```

  `PurchasePage.tsx:142-160` 已经是这种正确写法（两个按钮各自 `patchForm({ unit: 'base' | 'box' })`），照抄即可。

#### M8
- **级别**：Medium
- **位置**：`src/ui/pages/HistoryPage.tsx:65`（每行 `lines.filter((l) => l.orderId === o.id).length`），配合 `:53-111` 全量渲染所有订单
- **问题描述**：历史页对**每个订单**都扫一遍全量 `lines` 数组求商品数，且列表没有任何分页/截断/虚拟化。
- **为什么是问题**：复杂度 O(订单数 × 明细数)，且每次任意数据变化（`useLiveQuery` 换引用）、每次打开/关闭详情 Sheet 都会重跑。一个季度几千条明细时是数千万次比较，手机上可感知掉帧；这与基线 M-006（ReportPage 的选场次抽屉在渲染体内逐场次 `sessionReport`）是**同一类问题的另一处实例**，但位置不同、需单独修。
- **具体修复建议**：一次循环建索引并 memo：

```tsx
const lineCountByOrder = useMemo(() => {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.orderId, (m.get(l.orderId) ?? 0) + 1);
  return m;
}, [lines]);
// 渲染
<div className="glass-list__subtitle">{lineCountByOrder.get(o.id) ?? 0} 个商品</div>
```

  订单量再涨就按天折叠（默认只展开最近 3 天）或分页，不要一次性渲染全部。

#### M9
- **级别**：Medium
- **位置**：`src/ui/kit.tsx:459-475`（`<Field label="分类">` 包的是 `<div className="chip-row">`）
- **问题描述**：`Field` 会给子元素 `cloneElement` 注入 `id`，然后用 `<label htmlFor={id}>` 做关联；但「分类」这一项的子元素是 `div`，不是可标注表单控件。
- **为什么是问题**：`label for` 指向非可标注元素 → **关联无效、点击标签无反应、读屏不会念出「分类」**，4 个 `aria-pressed` 按钮成为一组没有名字的开关。根因是 `Field` 的 API 被当成「任意内容分组框」误用（`Field` 对 `input/select/textarea` 的注入本身是正确好用的，`aria-describedby` 那套也生效）。
- **具体修复建议**：分类这种「一组按钮」不要走 `Field`，改用命名分组：

```tsx
const catId = useId();
<div role="group" aria-labelledby={catId}>
  <div className="glass-label" id={catId}>分类</div>
  <div className="chip-row">{/* …按钮… */}</div>
</div>
```

  或在 `Field` 内判断子元素是否可标注（`input/select/textarea`），否则只渲染 label 文本、不写 `htmlFor` 与 `aria-describedby`。

#### M10
- **级别**：Medium
- **位置**：`src/ui/pages/StockPage.tsx:192`（`days <= 30` 时出「临期」徽标）对比 `src/ui/pages/ReportPage.tsx:465`（`expiryWarnings(..., warnDays)`，阈值来自用户设置）
- **问题描述**：库存页把临期阈值写死 30 天，报表页用设置里的 `warnDays`。
- **为什么是问题**：用户在设置里改成 15 或 60 天（`SettingsPage.tsx:176-184` 可改，`App.tsx:52` 会解析）后，**两个页面对「临期」的判断不一致**：库存页完全不看设置，同一批次可能在报表里判为临期、库存页却不提示。`30` 也是本项目唯一没走常量的预警天数魔法数（`useBoot.ts:44`、`App.tsx:52`、`SettingsPage.tsx:139/182` 另有三处字符串 `'30'`）。
- **具体修复建议**：`StockPage` 增加 `warnDays` prop（`useAppData().warnDays` 已有该值，经 `StockTabPage` 传入即可），判定改 `days <= warnDays`；默认值统一提成 `DEFAULT_EXPIRY_WARN_DAYS = 30` 并替换那四处的 `'30'`。

#### M11
- **级别**：Medium
- **位置**：`src/ui/pages/PurchasePage.tsx:66-73`（`slice(0, 30)`）+ `:265`（文案「今天已录 {todayBatches.length} 条」）
- **问题描述**：`todayBatches` 被 `slice(0, 30)` 截断，而同一条列表入口的文案直接拿 `todayBatches.length` 当「今天已录 N 条」。
- **为什么是问题**：当天录到第 31 条起，入口文案永远显示「今天已录 30 条」，与真实条数不符，用户会以为漏录并重复录入（进而在 FIFO 上多算一批成本）。`30` 也是无名魔法数。
- **具体修复建议**：统计与展示分离：

```tsx
const todayCount = useMemo(() => batches.filter((b) => b.receivedAt === today).length, [batches, today]);
const todayBatches = useMemo(() => /* 仍取前 TODAY_LIST_LIMIT 条，按 createdAt 倒序 */, [batches, today]);
// 入口文案：今天已录 {todayCount} 条
// 抽屉标题：共 {todayCount} 条 · 显示最近 {todayBatches.length} 条
```

  `TODAY_LIST_LIMIT = 30` 提到模块常量区。

### Low（15 条）

#### L1
- **级别**：Low
- **位置**：`src/ui/RecordEditor.tsx:264`（`key={`${l.productId}-${i}`}`）
- **问题描述**：列表 key 里含数组下标。
- **为什么是问题**：删除中间一行后，后面所有卡片 key 变化 → 全部卸载重建：输入框失焦、`amountRefs` 被清空重设。金额是受控的所以数值不丢，但对摊主就是「改到一半光标没了」；同时每次删行都会产生与剩余行数成正比的 DOM 重建。
- **具体修复建议**：给草稿行加稳定 id——`RecordLineDraft` 增加 `key: string` 字段（`newLine()` 里 `key: crypto.randomUUID()`），渲染用 `key={l.key}`；`amountRefs` 一并从数组下标改为 `Map<string, HTMLInputElement>`，彻底摆脱下标。

#### L2
- **级别**：Low
- **位置**：`src/ui/RecordEditor.tsx:148-149`（`onRemoveLine`）
- **问题描述**：删行只做 `setLines((lines) => lines.filter((_, i) => i !== idx))`，**不调整 `errorIndex` / `errorText`**。
- **为什么是问题**：校验失败后删掉出错那一行，红色提示会停留在下一行的位置（`RecordLineCard.tsx:123` 用 `errorIndex === i` 判断），或指向一个已经不存在的行（`validate` 里 `amountRefs.current[bad]?.focus()` 也就无从聚焦）。
- **具体修复建议**：删行时一并复位，`setErrorIndex` 已从 hook 导出（`useRecordDraft.ts:290`）：

```tsx
const onRemoveLine = (idx: number) => {
  setLines((lines) => lines.filter((_, i) => i !== idx));
  setErrorIndex(null);   // errorText 仅在 errorIndex 命中时渲染
};
```

#### L3
- **级别**：Low
- **位置**：`src/ui/RecordLineCard.tsx:111`
- **问题描述**：`` label={`成交金额（元 / ${unitLabel === '箱' ? '整行' : '整行'}）`} `` —— 三元两个分支完全相同。
- **为什么是问题**：死三元：`unitLabel`（`:38` 计算）算了没用，标签永远显示「整行」，读者无法从代码判断本意是「元/箱」还是「元/整行」；静态检查与 review 都会把它当可疑代码反复确认，属于纯噪音。
- **具体修复建议**：明确语义后直写——整行成交就 `label="成交金额（元 / 整行）"`；若想按单位区分则写 `unitLabel === '箱' ? '整箱' : '整行'`。顺手删掉不再使用的 `unitLabel` 变量（`gift` 分支外已无其它引用）。

#### L4
- **级别**：Low
- **位置**：`src/ui/useRecordDraft.ts:121-124`（`factorOf`）vs `:240`（`buildInputFrom` 内联同款三元）
- **问题描述**：`factorOf(l)` 已封装「箱 → 基本单位」换算，`buildInputFrom` 里又内联写了一遍 `l.unit === 'box' && p && p.boxQty > 1 ? p.boxQty : 1`。
- **为什么是问题**：同一文件两份换算规则，且两份表达式目前**完全等价**（都是 `l.unit === 'box' && p && p.boxQty > 1 ? p.boxQty : 1`），正因如此才只能靠肉眼比对来保证一致；将来若在 `factorOf` 里加特例（例如按单位取整策略），另一处不会跟着变，单据保存的数量与界面显示的数量就会分叉。**注意：这不是基线 N3**——N3 指「卡片与 hook 各一份」，需两处同步；这里是 hook 内部自重复，直接调用即可，零风险。
- **具体修复建议**：`const f = factorOf(l);` 替掉内联表达式。

#### L5
- **级别**：Low
- **位置**：`src/ui/recordDraft.ts:83`（`loadDraft` 拒收空行）vs `src/ui/useRecordDraft.ts:103`（保存侧把「只有备注」当非空）
- **问题描述**：保存侧 `const empty = draft.lines.length === 0 && !draft.note.trim();` —— 只填了备注也会 `saveDraft`；读取侧 `if (!Array.isArray(d.lines) || d.lines.length === 0) return null;` 直接把这类草稿丢弃。
- **为什么是问题**：只填备注、还没加商品就离开的草稿**永远恢复不出来**，用户看到的是「提示已保存草稿，回来却是空的」，两侧契约不一致。
- **具体修复建议**：统一成「有备注或有行即有效」：`if (!Array.isArray(d.lines)) return null; if (d.lines.length === 0 && !(typeof d.note === 'string' && d.note.trim())) return null;`；或反过来在保存侧连备注一起不存，并去掉 `useRecordDraft.ts:103` 的 note 参与判断。

#### L6
- **级别**：Low
- **位置**：`src/ui/pages/ReportPage.tsx:464-468`
- **问题描述**：`expiryWarnings` 的 `useMemo` 依赖被人为屏蔽（`// eslint-disable-next-line react-hooks/exhaustive-deps`），依赖列表写的是 `[batches, fifo, warnDays, products]`，而回调实际闭包的是 `productByName`。
- **为什么是问题**：目前靠 `productByName` 由 `products` memo 而来「碰巧」等价，一旦有人改 `productByName` 的构造方式（例如加上对 `settings` 的依赖）就会拿到陈旧闭包；屏蔽注释让后续 review 无从校验这个契约。
- **具体修复建议**：依赖改回真实闭包变量并删掉 disable——`productByName` 本身是 `useMemo`（`:419-423`）的稳定引用，加进去不会引起多余重算：`[batches, fifo, warnDays, productByName]`。

#### L7
- **级别**：Low
- **位置**：`src/ui/MorePage.tsx:81-157`（三个 `<li>` 各自手写 `role/tabIndex/onClick/onKeyDown`），而 `src/ui/kit.tsx:151` 已导出 `rowProps`
- **问题描述**：同一段键盘可达性代码在 `MorePage` 内复制了三份，且未使用项目已有的 `rowProps` helper（`RecordPage`、`HistoryPage`、`ProductsPage`、`StockPage`、`PurchasePage` 都在用）。
- **为什么是问题**：将来要统一加 `aria-haspopup`、改键位、或修「空格滚动冲突」，就得改 4 个地方；`MorePage` 也是全项目唯一没用共享 helper 的列表页，属于典型的局部偏离约定。
- **具体修复建议**：`{...rowProps(() => onOpen('products'))}`、`{...rowProps(() => onOpen('history'))}`、`{...rowProps(() => onOpen('settings'))}` 三处替换，并删掉 `import type { KeyboardEvent } from 'react'` 与那段内联对象字面量。

#### L8
- **级别**：Low
- **位置**：`src/ui/pages/SettingsPage.tsx`（全文 28 处 `style={{…}}`，全项目最多；其后是 `ReportPage.tsx` 9 处、`StockPage.tsx` / `CloseSessionSheet.tsx` 各 7 处）
- **问题描述**：大量内联样式，且含裸数字：`gap: 8`、`margin: '4px 4px 8px'`、`marginTop: 10`、`flex: 1`、`marginTop: 12` 等。
- **为什么是问题**：`src/tokens.css:131` 自己写明「组件尺寸全产品统一，**页面不得另写数字**」，而页面层恰恰是裸数字最多的地方：设计令牌调整时页面不跟随、`4px/8px` 与 `--yh-space-1/--yh-space-2` 混用导致同一视觉意图两套写法、每次渲染都生成新对象（`style` 对象无法被缓存）。其中 `style={{ margin: '4px 4px 8px' }}` 在 `RecordPage.tsx:152`、`ReportPage.tsx:233`、`ReportPage.tsx:344` 三处完全重复。
- **具体修复建议**：把重复形态提成类——`.sheet-actions-row`（`gap: var(--yh-space-2)`）、`.section-head`（替代三处 `margin: '4px 4px 8px'`）、`.flex-1`；一次性 `gap: 8` 改成 `gap: var(--yh-space-2)`。优先改 `SettingsPage` 里重复度最高的 `style={{ marginTop: 10 }}` 与 `stack-sm` 上的 style。

#### L9
- **级别**：Low
- **位置**：`src/ui/pages/SettingsPage.tsx:630-632`、`:642-644`（`pending.productDiffs.map((d) => <li key={d}>{d}</li>)`）
- **问题描述**：key 用展示文本 `d`。
- **为什么是问题**：合并预览里两条完全同名的变化（例如两个同名商品各自「新增：大地红 1000 响（¥50）」）会得到重复 key → React 重复 key 警告 + 列表项复用错位，而这种同名商品在烟花摊上并不罕见（不同批次的同款）。
- **具体修复建议**：`diffProducts` 改为返回 `{ id: string; text: string }[]`，渲染用 `key={d.id}`；临时方案可用 `key={`${i}-${d}`}`。

#### L10
- **级别**：Low
- **位置**：`src/ui/AppShell.tsx:88-93`（`useTheme`）
- **问题描述**：`localStorage.setItem('yh-theme', theme)` **没有** `try/catch`；而同文件 `initialTheme()`（`:75-82`）的读操作是包了 `try/catch` 的。
- **为什么是问题**：隐私模式（Safari「无痕」、部分安卓省电模式）或配额异常时写会抛，`useEffect` 从中断处停止执行 —— 由于 `document.documentElement.dataset.theme = theme` 在写之前，主题本身还能生效，但紧随其后的 `theme-color` meta 改写会**永远不执行**（状态栏颜色与实际主题不一致），异常还会冒泡成未捕获错误。读写不对称说明这是遗漏，不是设计。
- **具体修复建议**：与 `recordDraft.ts:52-67` 的 `writeLastPay` 保持一致：

```ts
useEffect(() => {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('yh-theme', theme); } catch { /* 隐私模式忽略 */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#070a10' : '#eef2f6');
}, [theme]);
```

#### L11
- **级别**：Low
- **位置**：`src/ui/AppShell.tsx:416-421`
- **问题描述**：`AppMain` 的 JSX 里残留空行：

```tsx
<>
  {SubPageView ? <SubPageView /> : <TabPage />}

  
</>
```

- **为什么是问题**：纯噪音，diff 里容易被误读成「这里本来还有个元素被删掉了」；也说明该处缺少内容（例如本该有的底部占位或骨架）。不影响运行。
- **具体修复建议**：删除空行，fragment 可以再收缩成 `{SubPageView ? <SubPageView /> : <TabPage />}` 直接放在 `<Suspense>` 里。

#### L12
- **级别**：Low
- **位置**：`src/ui/pages/HistoryPage.tsx:160-166`
- **问题描述**：明细行展示 `{数量} × ¥{unitPriceFen}`，尾列展示 `amountFen`，而 `unitPriceFen` 在保存时是 `Math.round(amount / qtyBase)`（`src/ui/useRecordDraft.ts:248`）。
- **为什么是问题**：整行让利后单价必然带余数，例如让利 ¥10 / 3 件 → 展示「3 × ¥3.33」而合计显示「¥10.00」，`3 × 3.33 = 9.99 ≠ 10`，对账时容易被当成算错。**金额本身没有浮点误差**（全程整数分），只是展示的乘法关系对不上。
- **具体修复建议**：明细行改成不会诱发心算的写法，例如「¥3.33/件 · 整行 ¥10.00（另让 ¥0.01）」；或只显示整行金额 + 数量，不显示折算单价。

#### L13
- **级别**：Low
- **位置**：`src/ui/App.tsx:72-77` 与 `src/ui/pages/ReportPage.tsx:430-436`
- **问题描述**：「本机进行中场次」的判定（`status === 'open' && deviceId === …`，再按 `startedAt` 倒序取第一个）写了两份。
- **为什么是问题**：规则一旦改（例如允许一台设备多场并开、或改成按 `closedAt` 排序、或加上 `voided` 过滤），两处必须同步，否则**首页显示的场次和报表统计的场次会指向不同对象**，而这种不一致极难在测试中被发现。项目里已有 `src/db/sessionLogic.ts` 适合承载这类纯函数。
- **具体修复建议**：在 `src/db/sessionLogic.ts` 导出 `pickOpenSession(sessions, deviceId): Session | undefined`，`App.tsx` 与 `ReportPage.tsx` 共同引用；`ReportPage` 里 `deviceSessions` 的过滤也可一并抽成 `sessionsOfDevice()`。

#### L14
- **级别**：Low
- **位置**：`src/ui/pages/StockPage.tsx:164` 与 `:168`
- **问题描述**：`batchStock(batches, open.id, fifo)` 在同一次渲染里被调用两次（一次判长度，一次 `map`）。
- **为什么是问题**：每次渲染对全部批次扫两遍，批次多了以后是双倍开销；两处调用之间理论上还可能因为数据更新产生不一致（判空用的是旧结果、`map` 用新结果）。
- **具体修复建议**：

```tsx
const rows = useMemo(
  () => (open ? batchStock(batches, open.id, fifo) : []),
  [batches, open, fifo]
);
// rows.length === 0 ? <Empty …/> : rows.map(…)
```

#### L15
- **级别**：Low
- **位置**：`src/ui/RecordLineCard.tsx:81-89`
- **问题描述**：数量只能靠 `−` / `+` 步进，中间的数字是 `<span className="val">{Math.round(l.qtyBase / factor)}</span>`，**不能直接输入**。
- **为什么是问题**：卖 50 挂就要点 50 次（切到「箱」只把步长放大为 `boxQty`，对 `boxQty = 1` 的商品无效）；键盘与读屏用户同样只能反复触发按钮，是交互效率与可达性的双重短板。
- **具体修复建议**：把数字槽换成可聚焦的小输入框（`inputMode="numeric"`、`aria-label={`${p.name} 数量`}`），`onBlur` 时 `clamp(1, …)` 并按 `factor` 对齐后回写 `qtyBase`，保留 `syncAmount` 联动；同时保留加减按钮与「同商品连点自动 +1」（`useRecordDraft.ts:136-150`）的便利。注意输入过程中不要把空串立即夹成 1，否则光标会跳。

---

## 三、按审查维度的覆盖情况

| 维度 | 结论 |
|---|---|
| **正确性**（hook 依赖 / effect 清理 / 闭包陈旧值 / 竞态 / 受控输入 / 金额精度 / key / 条件分支） | 有实质发现：M1（滚动锁嵌套）、M2（定时器未清）、M7（toggle 语义）、L1（index key）、L2（删行不修 errorIndex）、L5（草稿读写契约不一致）、L13（同一规则两份实现）。**`useMemo`/`useCallback` 的依赖数组整体是认真写过的**：`App.tsx:144-186` 甚至写了依赖链推导注释并逐项列全，`App.tsx:190-206` 的读写 Context 分离、`useSync.ts:121-124` 的返回 memo 都正确；`useSync.ts:79-119` 的 5 个监听器 + `setInterval` + `retryTimer` + `debounce` 清理完整，无泄漏。`useRecordDraft` 的 `useState(() => …)` 只初始化一次是**有意为之**（草稿基线与 `mountDraftRef` 配合），未发现陈旧闭包导致的错值；`switchUnit` 内读 `draft.lines[idx]` 属当前渲染值，在 React 事件批处理下安全。受控输入全部走 `value + onChange`，未发现 `defaultValue` 混用。 |
| **金额精度** | **未发现浮点累加误差风险**。金额全程是整数分（`RecordLineDraft.amountFen`、`SalesOrder.totalFen`、`useRecordDraft.ts:255-266` 的 `total/discount/giftCost` 累加的都是整数），非法输入用 `-1` 哨兵值而非 `NaN`（`recordDraft.ts:118-121`）。唯一取整点是 `unitPriceFen = Math.round(amount / qtyBase)`（`useRecordDraft.ts:248`），只影响展示（见 L12），不影响合计与库存成本。 |
| **React 性能** | 过滤/排序/聚合基本都进了 `useMemo`（`RecordPage.tsx:57-70`、`HistoryPage.tsx:23-43`、`StockPage.tsx:30-52`、`ReportPage.tsx:419-468`、`ProductPicker.tsx:31-38`）；`RecordLineCard` 每次键入会让所有行重渲染，但行数很小、暂不必上 `memo`。真正的问题是 **M8 的 O(订单数 × 明细数)**、L14 的重复全表扫描，以及基线已记录的 `App.tsx:38 useLiveQuery(loadAll)` 全量重读（M-001，仍在，不重复报告）。8 条「最近流水」无需虚拟化，但 `HistoryPage` 全量订单**没有分页**（已并入 M8）。**IndexedDB 查询未在渲染期同步发起**——全部走 `useLiveQuery` 或 `async/await`，这一点未发现问题。 |
| **状态管理** | **未发现错误提升到全局的 UI 状态，也未发现该用 `useMemo` 却用 `useState` 的冗余派生**。组件级状态粒度合理（`HistoryPage.openId`、`ReportPage.mode/pickedId`、`PurchasePage.form` 对象化、`SettingsPage.pending`）；两个 Context value（读/写）分离得当，`RecordEditor` 的 `editorInitial` 由 App 层 memo 后下发，未在页面内重复计算。唯一可提的是 `RecordEditor.tsx:96` 的 `originalRef`（撤销用的初始草稿快照）与 `data` 里的订单同时存在，但它们用途不同（一个必须冻结、一个必须最新），属合理设计，不计问题。**同一份数据既存 state 又存 ref 的情况：未发现**。 |
| **可访问性与交互** | 有 3 条：M9（`label for` 指向 div）、M10（临期阈值与设置不一致）、L15（数量不能直接输入）。**触摸目标这一项做得很好**：`tokens.css:143 --yh-touch-min: 44px` 被 `.stepper button`（`styles.css:406-408` 经 `--yh-icon-btn:44px`）、`.icon-btn`、`.chip-row .glass-badge`、`.glass-segmented__item`、`.glass-sheet__close`、`.checkout-dock__count`、`purchase-extra > summary`、`.link-btn`（`record.css:55`）逐一落实；`focus-visible` 焦点环（`styles.css:597`、`record.css:70/398`）与 `prefers-reduced-motion`（`styles.css:884-902`）都在。空态覆盖齐全（`Empty` 用于空列表、空搜索、空批次、无场次等 10 余处）。**弱网/离线提示**：记账页有常驻提示（`RecordPage.tsx:78-83`「离线，照常记账」），更多页有同步状态文案（`MorePage.tsx:34-42`），`UpdateBar` 有版本提示；真正的缺口不是“缺提示”，而是 **M3 那类「写失败完全静默」**。另有一处未单列：`rowProps` 给 `<li>` 加 `role="button"` 会抹掉 `<ul>` 的列表语义（`RecordPage.tsx:171-189`、`HistoryPage.tsx:67`、`ProductsPage.tsx:79` 等），影响较轻，可在统一重构 `rowProps` 时一并考虑。 |
| **可维护性** | M11（30 截断 + 文案不符）、L3（死三元）、L4（hook 内部换算重复）、L7（`MorePage` 重复三份 `rowProps`）、L8（内联样式与裸数字）、L9（文本作 key）、L11（JSX 空行）、L13（同一规则两处）。**体量类问题不再重复报告**：A1（`SettingsPage` 573 行/17 state）、A2（`RecordEditor` 557 行）、A3（`ReportPage` 432 行）、A4（`AppMain` 平铺）、A8（`Sheet` 125 行）、D1/D3/D5（props 数量）均已在基线「已消除」，`SettingsPage` 现为「65 行容器 + 4 个 section 同文件」的既定结构（决策记录第 12 条），不再提。命名全程 camelCase，未发现反例；文案常量已有 `PAY_LABEL` / `DELETED_PRODUCT` / `SNAPSHOT_REASON` / `SESSION_GONE_MSG` 等集中定义，剩余硬编码主要是 `30`（M10/M11）与 `260`（M2）。 |
| **CSS / 设计令牌** | **未发现 High / Medium 问题**。`tokens.css` 的三层结构（Primitive / Semantic / Component）边界清楚、注释交代了取用规则与对比度校验值；语义层按 `[data-theme='dark'|'light']` 两套覆盖，GlassKit 通过 `--gl-*` 桥接而非硬改；`!important` 全项目仅 4 处且都在减动效降级里；裸 px 仅 27 处，多为组件固定尺寸并有注释说明理由。问题集中在**页面层的内联样式**（L8），属 TSX 侧而非 CSS 侧。 |

---

## 四、基线中仍存在、本报告不重复计入的项

以下三项在 `docs/代码异味基线-20261110.md` 中已被记录为「仍待处理」，本轮核实**仍然存在**，故只标注、不计入新发现：

- **M-001**：`src/App.tsx:38`（`useLiveQuery(() => loadAll(), [])`）+ `:41-70`（三个 `useMemo` 依赖 `[data]`）——任意一表写入都会重读 7 张全表并让 FIFO/库存/均价三个 memo 全部作废重算。依赖收窄到各自数组可至少省掉「只改 settings 也重放 FIFO」。
- **M-006**：`src/ui/pages/ReportPage.tsx:561-562`——「选场次」抽屉在渲染体内对每个历史场次调用 `sessionReport()`，每次展开/父组件重渲染都会全量扫描。与本次的 M8 同类，建议一并修（抽屉改读场次上已持久化的 `summary` 快照）。
- **M-008**：`src/db/repo.ts` `updateRecord` 整组重建明细（2N 条发件箱记录）——数据层维度，不在本轮前端范围内。

---

## 五、前端整体评价

这块前端的真实水位是「**结构清楚、纪律感强，但错误、并发、模态嵌套这类边界情况的系统性兜底还缺一层**」。好的部分很扎实：读写分离的 Context（`App.tsx:151-206`）、稳定的 `showToast`/`sync` 引用、克制而正确的 `useMemo`、金额统一走整数分、44px 触控目标与减动效降级逐条落实、令牌三层结构与 GlassKit 的桥接干净——这些不是随手写出来的，看得出已经过一轮认真的重构，代码可读性明显高于同规模的个人项目。

反过来，能被用户真正撞上的缺陷几乎集中在「**失败与重复**」上：写库裸 `await` 无提示（M3）、确认框与商品表单没有 busy 能点两次（M4/M5）、弹层嵌套把滚动锁顶掉（M1），以及 PWA 被系统回收后草稿蒸发（M6）。它们看起来是四个独立问题，本质却是同一件事——**默认「一次就会成功」**，而这恰好是摊位弱网、手机内存吃紧时最不成立的前提；修复它们大多不需要动架构，是几十行的局部加固。

另外两处值得单独强调：`Sheet` 的滚动锁嵌套（M1）和「无错误边界」（H1）都是**低成本、高收益**的加固点，尤其 H1——一个二十行的 class 组件就能把「整屏白」降级成「这一页打不开，重新打开」，对本地优先产品来说这笔投入的回报率最高。

总体判断：**可以上真机试用（M6 里程碑）**，但建议把 H1 + M1 + M3 这三条列为试用前的加固项，其余按体验打磨排期；M-001 / M-006 / M-008 维持基线的既有判断，不建议在本轮一起动。