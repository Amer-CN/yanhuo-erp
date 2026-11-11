# UI 修复自检报告（2026-11-10）

> 范围：前端 P1-1 ~ P1-8 修复的可核验自检
> 工作目录：`F:\AIXM\烟花爆竹`
> 改动边界：仅 `src/ui/**`、`src/main.tsx`、`src/styles.css`；未触碰 `src/db/**`、`tests/**`、`vitest.config.ts`
> 未执行：`pnpm build`、`pnpm test`（另有并行改动/由验证 agent 统一执行）

## 0. 结论

| 项 | 结果 |
|---|---|
| `pnpm exec tsc --noEmit` | **0 error**（输出为空，EXIT=0） |
| P1-1 ~ P1-8 | **8/8 ✅ 全部完成**，均已用 grep/read 取证（见第 2 节） |
| 8 项打磨（时间允许项） | **8/8 ✅ 完成**（见第 3 节） |
| 有半成品/需补做 | 无（第 6 节的 2 条遗留已于本轮补修，见 6.1 / 6.2） |

## 1. tsc 真实输出

环境：Node `v24.22.1`，pnpm `12.3.4`。命令：

```powershell
pnpm exec tsc --noEmit
```

真实输出（前 40 行，实际为空）：

```
（无任何输出）
```

机器化统计：

```
EXIT=0
error TS 计数=0
输出字节数=0
```

`tsconfig.json` 开启 `strict` / `noUnusedLocals` / `noUnusedParameters`（`include: ["src","tests","vite.config.ts"]`），因此也同时证明了没有残留的未使用导入/变量（例如 `MorePage` 里已删掉的 `KeyboardEvent` 导入）。

## 2. 逐项核对（✅/❌ + 证据）

### P1-1 错误边界 ✅

- 文件：`src/ui/ErrorBoundary.tsx`（存在，96 行）
- 挂载 2 处：
  - `src/main.tsx:8` 导入、`:13` `<ErrorBoundary fallback={<ShellErrorFallback />}>`、`:15` 闭合（外壳级）
  - `src/ui/AppShell.tsx:37` 导入、`:384-431` 在 `<Suspense>` **外层**再包一层（页面级），`fallback={(error, reset) => <PageErrorFallback error={error} onRetry={reset} />}`
- 关键代码：

```tsx
static getDerivedStateFromError(error: Error): ErrorBoundaryState { return { error }; }
componentDidCatch(error: Error, info: ErrorInfo) {
  console.error('[ErrorBoundary] 页面渲染失败：', error, info.componentStack);
  this.props.onError?.(error);
}
reset = () => this.setState({ error: null });          // ErrorBoundary.tsx:44
```

- 两个 fallback：`ShellErrorFallback`（`window.location.reload()`，「页面没打开」）、`PageErrorFallback`（Card + 「重试本页」）。
- 额外加固：`resetKey`（`ErrorBoundary.tsx:22`、`:46-48`；由 `AppShell.tsx:380` 传入 `tab|sub|editor` 生成），避免某一页 chunk 坏掉后切页也被兜底拦住。无第三方库。

### P1-2 Sheet 滚动锁引用计数 + 定时器清理 ✅

`src/ui/kit.tsx`：

```
223: const SHEET_CLOSE_MS = 260;      // 注释：与 tokens.css 的 --yh-dur-sheet 同值
230: let sheetLockCount = 0;
231: let sheetSavedY = 0;
233-239: lockBodyScroll()   → if (++sheetLockCount !== 1) return; 只有 0→1 记录 savedY 并锁 body
241-248: unlockBodyScroll() → if (--sheetLockCount !== 0) return; 只有 1→0 才还原 + window.scrollTo(0, sheetSavedY)
282: lockBodyScroll();               // 挂载 effect 内
319: unlockBodyScroll();             // cleanup 内（不再读 scrollY）
326: const closeTimer = useRef<number | undefined>(undefined);
329: if (closeTimer.current) window.clearTimeout(closeTimer.current);   // 卸载清理
336-337: close() 先清旧定时器，再 setTimeout(..., SHEET_CLOSE_MS)
```

- 全文件仅 1 处字面量 `260`（即常量定义行），无残留硬编码延时；`src/styles.css`、`src/tokens.css` **未改动动画时长**。

### P1-3 写库 try/catch + busy + disabled ✅

| 页面 | 证据 |
|---|---|
| `PurchasePage.tsx` | `:59` `const [saving, setSaving] = useState(false)`；`:95` `if (saving) return`；`:103` `setSaving(true)`；`:120-124` `catch → onDone('没存上：…','error')` + `finally setSaving(false)`；`:238` `<Btn block onClick={save} disabled={saving}>` |
| `StockPage.tsx` | `:36` saving；`:78` `if (!open \|\| saving) return`；`:84` setSaving(true)；`:99-103` catch/finally；`:272` `disabled={saving}` |
| `ProductsPage.tsx` | `:21` saving；`:38-51` `save` 守门 + `finally`（错误故意不 catch，抛回 `ProductFormModal` 的 `err`，见 P1-4）；`:56-68` `doDelete` catch；`:157-169` 停用/启用 catch + `disabled={saving}` |
| `SettingsPage.tsx` | `:482` `const [clearing, setClearing]`；`:534-546` `runClearLocal` `if (clearing) return` + try/catch/finally；`:550` `confirmClearStep` 守门；`:743` ConfirmSheet `busy={clearing}` |

全量复核：`src/ui` 下所有 `await create*/update*/delete*/clear*/void*/restore*/close*/reopen*/save*/importMerge/replaceAll/clearCloud` 调用点（21 处）逐条确认都在 `try` 内或有上游 catch。

### P1-4 商品表单 / 确认框 busy ✅

- `kit.tsx` `ProductFormModal`：`:441` `const [saving, setSaving]`；`:446` `if (saving) return`；`:463-477` `try { await onSave(...) } catch (e) { setErr(\`没存上：…\`) } finally`；`:486-488` `<Btn block onClick={submit} disabled={saving}>{saving ? '保存中…' : '保存'}</Btn>`。
- 要求的 4 处 `ConfirmSheet` 均传 `busy` 且 `onConfirm` 用 `() => void doXxx()`：

| 文件 | busy | onConfirm |
|---|---|---|
| `HistoryPage.tsx` | `:229` `busy={voiding}` | `:230` `onConfirm={() => void doVoid()}` |
| `PurchasePage.tsx` | `:397` `busy={deleting}` | `:405` `onConfirm={() => void doDeleteBatch()}` |
| `ProductsPage.tsx` | `:213` `busy={deleting}` | `:214` `onConfirm={() => void doDelete()}` |
| `CloseSessionFlow.tsx` | `:170` `busy={flow.reopening}` | `:171` `onConfirm={() => void flow.handleReopen()}` |

- 4 处的失败语义统一：成功后才关框；失败保持框打开，并把原因就地渲染在 `description`（`glass-hint--error role="alert"`）里，不只发 toast。

### P1-5 草稿改 localStorage ✅

`src/ui/recordDraft.ts`：

```
75:  localStorage.setItem(key, JSON.stringify(draft));                    // saveDraft
84:  const raw = localStorage.getItem(key) ?? (legacy ? localStorage.getItem(legacy) : null);  // loadDraft
115: localStorage.removeItem(key);                                        // clearDraft
116-118: const legacy = legacyKeyFor(key); if (legacy) localStorage.removeItem(legacy);   // 旧键同源清理
```

- 文件头注释（`:1-3`）已同步说明「为什么用 localStorage 而不是 sessionStorage」。
- `draftKey()` 未改（`:43-46` 仍为 `:new` / `:edit:` / `:patch:`）。
- `try/catch` 全部保留。
- 残留的 `sessionStorage` 只出现在无关模块：`sellSession.ts:31/47`（**死代码，无任何引用**）、`UpdateBar.tsx:19/30`（"稍后提醒"标记，语义正确）。

### P1-6 单位切换显式 target ✅

```
RecordLineCard.tsx:33   onSwitchUnit: (unit: 'base' | 'box') => void;
RecordLineCard.tsx:63   onClick={() => onSwitchUnit('base')}
RecordLineCard.tsx:71   onClick={() => onSwitchUnit('box')}
RecordEditor.tsx:283    onSwitchUnit={(unit) => switchUnit(i, unit)}
useRecordDraft.ts:169   const switchUnit = (idx: number, target: 'base' | 'box') => {
useRecordDraft.ts:175   if (i !== idx || l.unit === target) return l;      // 幂等
```

幂等判断放在 `setLines` 的 updater 内（不是在事件处理器里读 `draft`），因此连点两次也不会互相覆盖。

### P1-7 库存口径与临期阈值 ✅

`src/ui/pages/StockPage.tsx`：

```
11:  const DEFAULT_EXPIRY_WARN_DAYS = 30;
19:  warnDays = DEFAULT_EXPIRY_WARN_DAYS,     // 解构默认值
28:  warnDays?: number;                       // prop 声明（不新增 Context）
65:  const rows = useMemo(() => (open ? batchStock(batches, open.id, fifo) : []), [batches, open, fifo]);
71-75: batchRemainingTotal = rows.reduce(...); adjustGap = openStock - batchRemainingTotal;
196-198: 「成本按批次计，不含盘亏/退货调整；其中调整 ±N 个（未分摊到批次）」
228: {days !== null && days <= warnDays ? (<span ...>临期</span>) : null}
```

- 传入点：`AppShell.tsx:473-482`（`StockTabPage` 从 `useAppData()` 取 `warnDays` 并经已有 props 传入）。
- 本文件内已无 `<= 30` 硬编码（grep 仅命中常量定义行与其注释）。
- FIFO 算法未改动（`src/db/calc.ts` 未触碰）；`当前库存` 改用 `openStock`（`:185`），与列表口径一致。

### P1-8 「今天已录 N 条」 ✅

`src/ui/pages/PurchasePage.tsx`：

```
9:   const TODAY_LIST_LIMIT = 30;
74:  const todayCount = useMemo(() => batches.filter((b) => b.receivedAt === today).length, [batches, today]);
83:  .slice(0, TODAY_LIST_LIMIT)
307: <div className="glass-list__title">今天已录 {todayCount} 条</div>
316-318: subtitle={`共 ${todayCount} 条${todayCount > todayBatches.length ? ` · 显示最近 ${todayBatches.length} 条` : ''}`}
```

列表中 `{todayBatches.length === 0 ...}` / `{todayBatches.map(...)}`（`:325/:329`）仍作用在截断后的数组上，属预期。

## 3. 时间允许的打磨（8 项，全部完成）

| 项 | 证据 |
|---|---|
| HistoryPage 一次建 Map 索引 | `HistoryPage.tsx:51-56`（`lineCountByOrder`），渲染 `:91` `lineCountByOrder.get(o.id) ?? 0` |
| StockPage `batchStock` 只算一次 | `StockPage.tsx:65` |
| 稳定 key + 删行复位 errorIndex | `recordDraft.ts:11`（`RecordLineDraft.key`）、`:125-130`（`newLineKey()`）、`:160`；`useRecordDraft.ts:21`；`RecordEditor.tsx:267` `key={l.key}`、`:148-153` `onRemoveLine` 内 `setErrorIndex(null)` |
| 死三元 + 删 `unitLabel` | `RecordLineCard.tsx:110` `<Field label="成交金额（元 / 整行）">`，`unitLabel` 已删除 |
| 复用 `factorOf(l)` | `useRecordDraft.ts:242` |
| 分类改命名分组 | `kit.tsx:443` `const catLabelId = useId()`、`:504-507` `role="group" aria-labelledby={catLabelId}` |
| MorePage 复用 `rowProps` | `MorePage.tsx:4` 导入，`:82/:98/:114` 三处；`KeyboardEvent` 导入已删 |
| 三处重复内联 margin 提 class | `styles.css:508-511` `.form-head--inset`；`RecordPage.tsx:152`、`ReportPage.tsx:233/344` 改为 `className="form-head form-head--inset"`（三处 `style={{ margin: '4px 4px 8px' }}` 已 0 命中） |

## 4. 明确未做 / 未改 + 原因

| 项 | 原因 |
|---|---|
| 旧 `sessionStorage` 草稿迁移到 localStorage | sessionStorage 几乎不可能跨版本存活；迁移代码反而引入新的串单面。旧键 `yh-record-draft` 的清理已指向 localStorage（`clearDraft`），不会残留新脏键 |
| 另外 3 处 `ConfirmSheet`（`RecordEditor.tsx:349` 放弃草稿、`SyncPanel.tsx:284` 关闭云同步、`SettingsPage.tsx:712` 撤销合并） | 不在本次指定的 4 处范围内；前两处是纯同步/UI 动作，第三处 `undoMerge` 已有 catch + toast |
| `sellSession.ts` 改用 localStorage | 该文件 **无任何引用**（死代码），优先按"不扩大改动面"处理，留给后续清理决策 |
| `RecordEditor.tsx` 撤销动作里的 `updateRecord` | 属 `onSaved(undo)` 闭包，调用与 catch 都在 `App.tsx`（`:124` `撤销失败：…`），不在本轮范围 |
| `pnpm build` / `pnpm test` | 明确禁止：`src/db/**` 有并行改动，dist 冲突与测试结果均不可信 |

## 5. 自检方法（可复现）

```powershell
# 1) 类型检查
pnpm exec tsc --noEmit          # 期望：无输出、EXIT=0

# 2) 逐项取证（示例）
Select-String -Path src/ui/kit.tsx -Pattern "SHEET_CLOSE_MS|sheetLockCount|closeTimer"
Select-String -Path src/ui/*.tsx,src/ui/pages/*.tsx -Pattern "<ConfirmSheet|busy=\{"
Select-String -Path src/ui/recordDraft.ts -Pattern "localStorage|sessionStorage"
Select-String -Path src/ui/pages/StockPage.tsx -Pattern "warnDays|adjustGap|DEFAULT_EXPIRY_WARN_DAYS"
Select-String -Path src/ui/pages/PurchasePage.tsx -Pattern "todayCount|TODAY_LIST_LIMIT"
Select-String -Path src/ui/*.tsx,src/ui/pages/*.tsx -Pattern "await (create|update|delete|clear|void|restore)"
```

## 6. 遗留观察（2 条已修，1 条保留）

### 6.1 嵌套 Sheet 的 Esc 双触发 —— ✅ 已修

- 位置：`src/ui/kit.tsx`
  - `:233-247` 模块级弹层栈 `const sheetStack: symbol[] = []` + `pushSheet(token)` / `popSheet(token)`（`lastIndexOf` + `splice`，幂等）
  - `:290-292` 每个实例一个稳定身份：`const tokenRef = useRef<symbol | null>(null); if (!tokenRef.current) tokenRef.current = Symbol('sheet');`
  - `:299-312` 进出栈跟着 `active`（展开态）走：`if (!active) { popSheet(token); return; } pushSheet(token); return () => popSheet(token);` —— `close()` 后 260ms 过渡期间已视觉关闭的弹层立刻让出栈顶，父组件延迟卸载也不会挡住下层 Esc
  - `:332-339` 只让栈顶响应：

```ts
if (e.key === 'Escape') {
  // 只有最上层弹层处理 Esc：嵌套时一次按键只关一层
  if (sheetStack[sheetStack.length - 1] !== token) return;
  e.preventDefault();
  if (dismissibleRef.current) close();
  return;
}
```

- 说明：本组件没有 `open` prop（由父组件条件挂载/卸载），因此「open 变化时同步进出栈」落在 `active` 上实现，覆盖了同一场景（关闭动画期间组件仍挂载）；`Tab` 焦点陷阱逻辑**未改动**，`preventDefault` 仍只在栈顶执行一次。

### 6.2 「只填备注」的草稿被丢弃 —— ✅ 已修

- 位置：`src/ui/recordDraft.ts:86-93`（`loadDraft`）

```ts
if (!Array.isArray(d.lines)) return null;
// 与保存侧契约一致：有行或有备注都算有效草稿。
// 只填了备注的草稿以前会被这里丢掉，用户看到「已保存草稿」回来却是空的。
const hasLines = d.lines.length > 0;
const hasNote = typeof d.note === 'string' && d.note.trim().length > 0;
if (!hasLines && !hasNote) return null;
```

- `draftKey` 语义与保存侧（`useRecordDraft.ts:105` `lines.length === 0 && !note.trim()`）**均未改动**。
- `lines: []` 恢复链路已跟过，无需额外兜底（`useRecordDraft.ts` 未改）：
  - `initialDraftState` → `matched = Boolean(saved)`（new 模式）→ `restored: true`，`showDraftHint` 显示「继续上次没记完的单？」；
  - `totals` 对空数组累加 → `{0,0,0}`；
  - `RecordEditor` 走 `draft.lines.length === 0` 的空态（「还没加商品」）；
  - `validate`（`useRecordDraft.ts:220-224`）对空行数组先 `onEmpty()` 返回 false，`:228` 的 `draft.lines[bad]` 只在 `findIndex` 命中（数组非空）时执行；
  - `switchUnit`（`:170-172`）已用 `const p = line ? … : undefined` 防御性取产品。
- 空草稿仍会被清理：`saveDraft` effect 的 `empty` 判定未变，`lines` 与 `note` 都空时 `clearDraft`。

### 6.3 `src/ui/sellSession.ts` 是死代码（保留，未改）

全仓无任何 import，且仍在用 `sessionStorage` 存购物车（`:31/:47`）。删除/接回属产品决策，不在本轮 UI 修复范围（改动会超出"只碰 kit.tsx / recordDraft.ts"的边界）。