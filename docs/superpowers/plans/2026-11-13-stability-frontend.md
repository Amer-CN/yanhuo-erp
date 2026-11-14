# 前端流程与恢复修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除编辑连续保存错单、建商品丢目标、危险操作误取消、不安全帮助和页面/键盘故障恢复问题。

**Architecture:** 保持当前页面与玻璃风格；使用明确 EditorState 和单个操作状态机表达用户意图。恢复/撤销的数据写入由配套后端计划定义，前端不直接拼装全库云端删除。UI 测试断言 IndexedDB 的订单 id、场次和金额，不只看 Toast。

**Tech Stack:** React 18、TypeScript、现有 kit/Sheet、Python Playwright、Vite PWA。

---

## 范围与文件图

总顺序、发布边界见 [总方案](2026-11-13-stability-repair.md)，共享数据契约见 [后端计划](2026-11-13-stability-backend.md)。F01/F03 可先做；F02 的恢复路径必须等 B05，清云路径等 B06。不更换字体、布局风格或导航体系。

> **2026-11-15 执行终态：F01–F05 本地实现与浏览器门禁完成。** 唯一进度、提交与终验凭证见[总方案](2026-11-13-stability-repair.md#最终验收记录2026-11-15)，下方未勾选任务卡保留设计步骤，不作为第二套状态。更新控制最终置于 `main.tsx` 的唯一 `AppUpdateProvider`；页面故障按钮为“重新打开应用”。独立专项分别为 stability / sync-recovery / sheet-keyboard / page-recovery / ui-edge / update，全部已进阻塞门禁；a11y 全局观察期不变。真机键盘、返回键和安装态PWA仍pending。

| 文件 | 职责/变更 |
|---|---|
| `src/App.tsx` | 保存建商品前的 editor 目标，精确返回；保存后的模式切换 |
| `src/ui/AppShell.tsx` | editor key、初始草稿和跨页回调；设置页 build/更新控制透传 |
| `src/ui/RecordEditor.tsx` | 按 mode 区分保存动作；建商品前保存草稿；正确回执 |
| `src/ui/useRecordDraft.ts` | 暴露立即保存草稿入口，沿用隔离草稿键 |
| `src/ui/pages/SettingsPage.tsx` | 清空/合并/恢复 busy 全程；删除整本 clear 的撤销路径；重新连接差异确认 |
| `src/ui/SyncPanel.tsx` | 使用唯一 SQL 正本，移除危险建议；呈现配置切换状态 |
| `src/ui/kit.tsx` | 顶层 Sheet 独占键盘陷阱；panel 初始反向 Tab；busy 禁止退出 |
| `src/ui/ErrorBoundary.tsx` | chunk 故障给出真实可恢复的刷新入口 |
| `src/ui/UpdateBar.tsx` | 更新控制提升共享，稍后后仍有入口 |
| `src/ui/pages/StockPage.tsx` | 关闭/切换商品重置调整草稿 |
| `src/ui/pages/HistoryPage.tsx` | 独立详情按钮与撤销按钮，去掉嵌套 button 语义 |
| `scripts/e2e-stability.py`（新） | F01/F02/F04/F05 的浏览器回归；loopback+隔离 context |
| `scripts/a11y-check.py` | 增补单层/嵌套 Tab、历史撤销和可访问名 |
| `.github/actions/e2e/action.yml` | 接入专项测试，保留现有门禁 |

测试脚本通用头：

```python
import os
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('STABILITY_BASE', 'http://127.0.0.1:4173/')
if urlparse(BASE).hostname not in {'127.0.0.1', 'localhost', '::1'}:
    raise SystemExit('专项回归只允许 loopback')

# 每个场景 new_context，不复用上个用例草稿。只有明确 mock 场景可开启同步。
# 为避免测试误连内置账本，context 路由先拦所有 /rest/v1/ 请求，再根据测试需要 fulfill。
```

所有 JSON 证据与截图输出 `STABILITY_OUT`（默认系统临时目录），不得覆盖现有审计截图。DB 读取只对该脚本新建的 context，使用原生 IDB，只读检索业务结果。

## F01 — 单据模式、连续保存与“建商品再返回”

**优先级：P1；依赖：B01。**

**Files:** 修改 `src/App.tsx`、`src/ui/AppShell.tsx`、`src/ui/RecordEditor.tsx`、`src/ui/useRecordDraft.ts`；新建 `scripts/e2e-stability.py`；修改 `scripts/e2e-edit-undo-v2.py`。

- [ ] **1. 固定失败用例。** 用 390×844 context 新建 ¥25 单 X，在首页点 X 编辑，改 ¥20 后点连续保存，再选 ¥1.50 商品保存。记录旧版本 `orders.length === 1`、X 被改成 150 分；保留这条基线证据。另造 closed 场 S 的 patch 草稿和 open 订单 X 的 edit 草稿，搜索不存在商品，建商品返回，记录 editor 标题/目标场次。
- [ ] **2. 明确保存 UI。** 编辑态只显示“保存修改”，不显示“保存并记下一单”；点击后仍用 `updateRecord`，完成回首页。防御性处理：即使旧事件传 `andNext=true`，edit 也按 false 收尾。new 保留原按钮；patch 连续动作标“保存并继续补记”，始终保留同一 sessionId。

```tsx
const canContinue = mode !== 'edit';
const continueLabel = mode === 'patch' ? '保存并继续补记' : '保存并记下一单';
const primaryLabel = mode === 'edit' ? '保存修改' : '只保存';
// submit 内所有分支、onSaved 和回执统一用 effectiveNext，不能只改显示。
const effectiveNext = canContinue && andNext;
```

- [ ] **3. 保存完整返回意图。** 将 App 的 boolean ref 改成 `EditorState | null`；已有 `EditorState` 是本方案依赖的真实类型，不另造新路由体系。建商品前显式 flush 草稿，再导航。没有 editor 的普通商品管理新建保持原样。

```tsx
const createProductIntentRef = useRef<EditorState | null>(null);
// onCreateProductForEditor:
if (!editor) return;
createProductIntentRef.current = { ...editor };
setEditor(null);
setSub('products');
// onProductCreated:
const resume = createProductIntentRef.current;
if (!resume) return;
createProductIntentRef.current = null;
setSub(null);
setPendingProductId(productId);
setEditor(resume);
```

`useRecordDraft` 新导出 `persistDraftNow()`：取消 saveTimer，把当前完整 draft（附 mode 对应的 orderId/sessionId）直接交给现有 saveDraft；清 pendingDraft，避免仅 flush 一个尚未被 effect 填充的旧 pending。空草稿走 clearDraft。RecordEditor 在 onCreateProduct 前同步调用它，不能仅等待 200ms debounce 或卸载清理。App 的 appActions/useMemo 依赖增加 editor，`clearCreateIntent` 改为写 null（不能残留 boolean false）。若 edit/patch 目标期间被删除或结账，返回后显示现有错误并保留草稿，不偷换成 new。退出商品管理/切 tab 清返回意图；测试输入最后一个字后立即跳转也保存成功。

- [ ] **4. 正向断言。** 编辑完成 X 仍为原 id、只有 1 单、金额/明细 ¥20；回首页主动新记 ¥1.50 后变 2 单，X 不变。patch 建商品后新增 order.sessionId 必须为原 closed S，`patchedCount` 增 1、不新开场。edit 建商品后仍保存 X，已有商品/金额/备注均保留；只把新商品加 1 次。测试刷新/取消商品创建都不串到后续单。

```python
# 新建后的订单集合由本用例原生 IDB 读取，禁止只凭成功提示判通过。
assert len(after_edit['orders']) == 1
assert after_edit['orders'][0]['id'] == original_id
assert after_edit['orders'][0]['totalFen'] == 2000
assert len(after_new['orders']) == 2
assert patched_order['sessionId'] == target_closed_session_id
```

- [ ] **5. 回归与提交。** `python scripts/e2e-stability.py`、`python scripts/e2e-edit-undo-v2.py`、`python scripts/e2e-smoke.py`、`pnpm exec tsc --noEmit` 全过；commit：`fix(record): preserve editor targets and prevent edit-as-new saves`。只提交列明文件。

## F02 — 危险操作状态机与恢复语义

**优先级：P1；F02a依赖B05（busy、取消、合并恢复边界）；F02b依赖B06（接入事务清云）。** 先完成F02a，并暂时关闭旧全云清空入口；B06完成后实现F02b，不让F02与B06互相等待。

**Files:** 修改 `src/ui/pages/SettingsPage.tsx`、`src/ui/SyncPanel.tsx`、`scripts/e2e-stability.py`；按 B05 使用 `src/db/syncControl.ts`（新）及对应导出。

- [ ] **1. 先复现网络取消窗口。** 假路由扣住 clear 请求，不立即返回；点击确认后尝试 cancel/X/Esc/浏览器返回。旧实现取消后产品数变 0 为失败证据。新增用例分别覆盖 RPC 成功、失败和超时，不能将“用户已经确认过”作为继续暴露取消按钮的理由。
- [ ] **2. 用一个 ref 级互斥保护全过程。** clear/restore/merge/undo 在第一行抢占 gate，不能只在 `runClearLocal` 才 set busy。单个状态保存阶段；函数重入直接返回。busy 覆盖云端请求、IDB 写和结果确认，不在云端阶段提前 finally 解锁。

```tsx
type DataAction = 'idle' | 'clearing-cloud' | 'clearing-local'
  | 'merging' | 'restoring' | 'undoing-merge';
const actionRef = useRef<DataAction>('idle');
const [action, setAction] = useState<DataAction>('idle');
const enter = (next: Exclude<DataAction, 'idle'>) => {
  if (actionRef.current !== 'idle') return false;
  actionRef.current = next;
  setAction(next);
  return true;
};
const leave = () => { actionRef.current = 'idle'; setAction('idle'); };
```

配合 `ConfirmSheet busy={action !== 'idle'}` 和 merge/restore `Sheet dismissible={action === 'idle'}`，表单控件也禁用；用 try/finally 统一退出。提交前 cancel 保持无副作用；提交后按钮说明“处理中”，不再显示“取消后什么都不会清”。

- [ ] **3. 撤销合并只恢复本机并暂停。** 删除 `undoMerge()` 的 `clearCloud(cfg)` 和随后 `afterMerge()` 全量标脏；走 B05 的恢复协调器。文案为“恢复本机到合并前，并暂停云同步；已同步到云端的合并不会被远程撤销”。完成后展示重新连接的差异预览入口。不能静默恢复自动同步。
- [ ] **4. 清云失败不误报本机成功。** B06 RPC 未部署/失败/状态未知时，保留本机；保留相同 operationId 供“查询结果/重试同一操作”。只有服务端确认事务已提交才能清本机。单独本地恢复/清空不复用全云 API。
- [ ] **5. 浏览器验收。** 请求在途不能关闭，最多 1 次提交；失败本机 8 商品和订单原样保留；提交前任一层 cancel 都不发写请求。合并、恢复时后台同步不会再落新行。执行 `python scripts/e2e-stability.py`、B05 数据层用例、`python scripts/a11y-check.py`、`pnpm exec tsc --noEmit`。
- [ ] **6. 提交。** `fix(settings): lock full data operations and preserve remote ledger on undo`。数据层 B05 提交须先独立合并，不把尚未实现 API 当占位代码留在产品。

## F03 — 唯一 SQL 帮助来源与安全配置

**优先级：P1；依赖：B01；最终内容跟随 B07。**

**Files:** 修改 `src/ui/SyncPanel.tsx`、`supabase/schema.sql`（B07 主责，禁止并行写）、`docs/03-云同步设置.md`、`scripts/e2e-stability.py`；新建 `tests/schema-help.test.ts`。

- [ ] **1. 失败断言。** 当前帮助正文含 `grant ... delete`、`using (true)`；源码 SQL 不是 schema 正本。新测试读取正本与 raw 导入，断言可执行部分不含授予 DELETE 或无条件 RLS；允许 schema 历史回滚注释存在，不能用简单搜索把注释也当执行语句。
- [ ] **2. 删除复制品。** SyncPanel 改用 Vite raw import：

```ts
import schemaSql from '../../supabase/schema.sql?raw';
// <pre>、复制按钮使用同一个 schemaSql，删除旧 const SQL。
```

帮助中的修复建议改为：“不要放开 RLS。请核对 URL/key、项目状态和迁移步骤；仍失败先导出备份，再联系维护者。”不能再引导 `using(true)`。schema 顶部写清新建/旧库升级/分阶段主键迁移的边界；旧库先执行 add-column migration，不能承诺任意版本重跑主文件即可完成全部协议切换。

- [ ] **3. raw 导入一致性测试。**

```ts
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import schemaSql from '../supabase/schema.sql?raw';
it('配置帮助使用同一个正式建库脚本', () => {
  expect(schemaSql).toBe(readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
  const executable = schemaSql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
  expect(executable).not.toMatch(/grant[^;]*\bdelete\b/i);
  expect(executable).not.toMatch(/using\s*\(\s*true\s*\)/i);
});
```

schema raw 文本包含 SQL 注释，但不包含任何实际凭据。测试 Node 模块类型按当前测试惯例解决，不升级 TypeScript/Vite 来过编译。

- [ ] **4. UI 验收。** disabled 同步时直接处于 editing，enabled 时先点修改配置，两条路径都能打开帮助；复制内容与正本一致；错误提示不能让用户降低 RLS。用 `context.route('**/rest/v1/**', abort)`，禁止实际执行 SQL。
- [ ] **5. 提交。** `fix(sync-help): use canonical schema and remove unsafe RLS fallback`。B07 最终复核这份帮助的 schema 阶段说明。

## F04 — 页面故障恢复、更新入口与 Sheet 键盘

**优先级：P2；依赖：F01/F02 集成。**

**Files:** 修改 `src/ui/ErrorBoundary.tsx`、`src/ui/AppShell.tsx`、`src/ui/kit.tsx`、`src/ui/UpdateBar.tsx`、`src/ui/pages/SettingsPage.tsx`、`scripts/a11y-check.py`、`scripts/e2e-stability.py`、`vite.config.ts`；新增 `src/ui/useAppUpdate.ts`。

- [ ] **1. 分别锁 3 个缺口。** A：中断一个懒加载页面 chunk，恢复网络后点重试仍失败；B：panel 初始 Shift+Tab；C：商品表单→删除确认框连续 Tab。断言焦点 DOM 节点、首尾环绕和只处理栈顶；不只断言“有 dialog”。
- [ ] **2. 故障入口说真话。** 页面 fallback 改“重新打开应用”，走 `window.location.reload()`，不再假装 reset 能重试 rejected lazy。保留路由变化清普通渲染错误能力。刷新前依赖现有草稿 pagehide flush，并测试带未保存草稿刷新可恢复；不自动 reload、不开无限重试。
- [ ] **3. 栈顶独占 Tab。** Tab 分支在 query focusable 之前检查当前 token 为栈顶；panel 本身+Shift+Tab 落最后一个控件；无可聚焦子控件时 preventDefault 并 focus panel。

```ts
if (e.key === 'Tab') {
  if (sheetStack[sheetStack.length - 1] !== token) return;
  const panel = panelRef.current;
  const items = focusable();
  if (!panel) return;
  if (items.length === 0) { e.preventDefault(); panel.focus(); return; }
  const first = items[0], last = items[items.length - 1];
  const outside = !panel.contains(document.activeElement);
  const atPanel = document.activeElement === panel;
  if (outside || (atPanel && e.shiftKey)) {
    e.preventDefault(); (e.shiftKey ? last : first).focus(); return;
  }
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault(); first.focus();
  }
}
```

保留 Esc/返回键只关一层、滚动锁引用计数。HistoryPage button 原生语义修复见 F05，不混在 focus 算法里。

- [ ] **4. 更新单一控制。** 把 `useRegisterSW` 提升到 `useAppUpdate`（main 根节点唯一 AppUpdateProvider），同时供 UpdateBar 和设置页使用；`later` 只控制横幅，不删除设置入口。设置页显示“当前版本/build”；有待更新时显示“更新并重新打开”，无待更新时显示“检查更新”。构建标识在 Vite build 时注入提交短哈希，测试允许工作区 dirty 后缀；不要靠手写版本号区分构建。`register.update()` 触发检查，`updateServiceWorker(true)` 只响应用户确认。
- [ ] **5. 验收。** 单层/嵌套各 10 次正反 Tab 无背景焦点；Esc、返回键仍一层一次；忙碌状态不能退出。懒 chunk 失败恢复网络后刷新能打开、草稿未丢；点稍后仍可从设置完成更新。390/320/768 宽、浅深色、reduced-motion；真实软键盘仍列真机验证。
- [ ] **6. 提交。** 键盘与更新/错误恢复可分别 commit：`fix(a11y): isolate keyboard focus to topmost sheet`、`fix(pwa): expose recoverable reload and persistent update entry`。

## F05 — P2 交互收尾与长期门禁

**Files:** 修改 `src/ui/pages/StockPage.tsx`、`src/ui/pages/HistoryPage.tsx`、`scripts/a11y-check.py`、`scripts/e2e-stability.py`、`.github/actions/e2e/action.yml`、`docs/02-使用说明.md`、`docs/08-运维手册.md`。

- [ ] **1. 库存草稿隔离。** 所有 open 路径走 `openAdjustment(id)`，所有关闭走 `closeAdjustment()`：

```ts
const resetAdjustment = () => {
  setAdjust(''); setReason(''); setDir('loss'); setAdjustHint('');
  if (hintTimer.current) window.clearTimeout(hintTimer.current);
};
const openAdjustment = (id: string) => { resetAdjustment(); setOpenId(id); };
const closeAdjustment = () => { if (saving) return; setOpenId(null); resetAdjustment(); };
```

修改实际存在的搜索列表/缺货列表入口；Sheet `dismissible={!saving}`，保存时禁止换商品。用例 A 填“多了5”取消→B 默认为空、“少了”，不能提交 A 的数值。
- [ ] **2. 历史记录语义。** `<li>` 保持非交互容器，将名称/金额/商品数包在独立详情 `<button type=button>`，撤销为同级 button；沿用现有 class 外观与44px触控盒。去掉该 li 的 `rowProps`。点击详情、撤销、Tab顺序、Enter、Space与读屏可访问名分别验证；不承诺未测的真机读屏结果。
- [ ] **3. CI 接入。** 在 smoke/mock sync/offline 后增加：

```yaml
- name: Stability UI regressions
  shell: bash
  run: python scripts/e2e-stability.py
- name: Recovery and concurrency regressions
  shell: bash
  run: python scripts/e2e-sync-recovery.py
- name: Manual merge regression
  shell: bash
  run: python scripts/e2e-merge.py
```

保持现有主门禁，不用 continue-on-error 掩盖新增专项失败。a11y 观察期现有全局设置不擅自改，但新修复的关键键盘断言也纳入阻塞的 stability 脚本。
- [ ] **4. 文档回写。** 使用说明更新编辑/补记保存文案、合并撤销只恢复本机、重新连接预览、清云事务要求和更新入口；运维不再推荐整个账本重复清空解决恢复问题。基线新增对应 F01–F05 结果与实际测试输出，原历史条目保留。
- [ ] **5. 通过总方案全部门禁，再提交。** `fix(ui): isolate inventory drafts and expose independent history actions`；CI 文档可另 `test(e2e): gate stability and recovery scenarios`。

## 前端交付检查

- [ ] 每个 P1 有当前坏版本失败与修复后通过证据。
- [ ] 编辑/补记/new 三种身份没有串目标；创建商品返回不清掉原草稿。
- [ ] 云端操作在途无假取消、无重复写；恢复/撤销不会清他端账本。
- [ ] 配置帮助与 SQL 正本同源；不提供 grant DELETE/using(true)建议。
- [ ] 键盘/错误恢复/更新入口真实可用，旧 e2e-merge 脚本修复并进门禁。
- [ ] 视觉检查只针对改动界面和320/390/768宽，保留当前设计，不新增装饰性改版。
- [ ] 真机键盘/系统回收/安装态 PWA 未验时明确 pending，不能用 Chromium 模拟替代。
