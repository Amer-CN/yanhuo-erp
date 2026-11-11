# 移动端交互细节自检（2026-11-11）

范围：本轮 4 批 UI 改造后的**当前磁盘代码**（未提交工作区），只读审查，未改任何源码。
方法：逐文件通读 + 关键 CSS 用 grep 落地；每条结论都带 `文件:行号`。标注「需真机」的条目无法离线定论。

## 一、20 项逐条结论

| # | 结论 | 证据（文件:行号） | 说明 |
|---|---|---|---|
| 1 | **问题** | `RecordLineCard.tsx:118-139`、`:120` | 输入 `0`/空/`000` → 失焦后一律夹到 1（不报错、无提示，想卖 0 会落成 1，L）。全角数字 `５` 被 `replace(/\D/g,'')` 吞成空串（输入框里的字会自己消失），失焦后落 1（M-04）。`3.5` 被吞成 `35` → 数量静默 ×10（M-04）。粘贴 `12345` 被 `slice(0,4)` 截成 `1234`（不是 9999，L-07）。前导零 `007`→`7` ✓。`8999`→`9999` 上限以内的 4 位正常。`editing` 不会卡死：删行=卸载、行 key 稳定（`recordDraft.ts:130`），输入中切单位/赠品都会先触发 blur。 |
| 2 | 通过（真机复核） | `RecordLineCard.tsx:111-143`、`useRecordDraft.ts:161-188` | ± 走 `changeQty`，输入走 `setQty`，两者都 `Math.max(1, …)` + `syncAmount`，口径一致。输入 `3` 后点 `+`：blur 先落 `setQty(3)`（无变化），再 `changeQty(+1)`→4，`editing=false` 后 `useEffect` 把 text 同步成 `4`（`:55-57`）。**唯一风险是 blur/click 顺序**（iOS Safari 点 button 不一定给焦点），见第三节。 |
| 3 | **问题** | `useRecordDraft.ts:199-204`、`:201`、`:203` | `baseBefore` 只在「base→box」时写一次；在**箱**模式下改了数量（± 或直接输入）后再点「个」，`qtyBase` 被还原成陈旧的 `baseBefore`，数量与金额一起回退（H-02）。另外 `Math.max(1, Math.floor(qtyBase/boxQty))`：3 个点「箱」→ 变 1 箱 = 10 个，金额立刻 ×boxQty 且无任何提示（M-01）。 |
| 4 | 通过 | `useRecordDraft.ts:36-43`、`:167`、`:185` | `amountTouched` 后改数量，两条路径都由 `syncAmount` 挡掉覆盖，行为完全一致；`setQty` 里「数量没变就直接 return」（`:184`）也不会误覆盖手填金额。 |
| 5 | **问题** | `HistoryPage.tsx:205-215`、`:211`、`kit.tsx:157`；`SettingsPage` 无关 | 连点两次「删除这笔」被 `busy={voiding}` + `voiding` 守卫挡住 ✓；但行内「撤销」无 busy，连点会跑两遍 `restoreOrder`（幂等，但连弹两条 Toast，L-04）。键盘 Enter 落在「撤销」按钮上时 keydown 冒泡到 `li` 的 `rowProps`，会**同时撤销并打开详情**（M-07）。按钮高 44px（`record.css:53-68`）但「撤销」二字宽度约 40px < 44（L-01）。`aria-label`「撤销删除 09:12 这一单」描述清楚 ✓。 |
| 6 | 通过 | `repo.ts:939-951`、`HistoryPage.tsx:158`、`:195-197`、`:202-215` | `restoreOrder` 删掉 `voided` 标记（`repo.ts:943`），liveQuery 重渲染后回到正常行样式、金额重新显示、删除线/徽章消失；只入队 1 条 outbox（`:944-950`），没有多余同步。撤销失败用 warning 语气偏轻（L-02）。 |
| 7 | **问题** | `App.tsx:50-53`、`SettingsPage.tsx:163-176`、`:172-173` | 非数字被 `replace(/[^\d]/g,'')` 清掉 ✓；超 3 位被 `maxLength={3}` 挡住 ✓（但粘贴静默截断）。**留空/只输空格 → 存 `''`**，`operators[0]` 回落到 `deviceName`，而 `deviceName` 也留空时两台机都叫「本机」→ 历史单与报表里两人无法区分（M-11）。输入 `000` 不被归一化，落库就是 `000`。 |
| 8 | **问题** | `useRecordDraft.ts:72-81`、`:82`、`recordDraft.ts:162` | 恢复**旧草稿**时 operator 已归一化到本机编号（`:77`）→ 头一单是新编号 ✓。但 `mode='edit'` 走的是 `initial`（`recordDraft.ts:162` 直接取 `order.operator`），**不做归一化**，改旧单保存后 operator 仍是「我/老婆」这类旧值（M-12）。 |
| 9 | **问题（轻）** | `AppShell.tsx:88-93`、`SettingsPage.tsx:186-199` | 三者同步 ✓：`dataset.theme` + `localStorage['yh-theme']` + `meta[theme-color]`（`#070a10`/`#eef2f6` 与 `--yh-canvas` 一致）。但 `localStorage.setItem` 无 try/catch，隐私模式抛错会让后面的 theme-color 永远停在旧值（L-06）；按钮夹在「临期预警」输入框正下方、整宽 secondary，失焦后手指落点极易误触，且切换**没有任何 Toast 或撤销入口**（M-13）。 |
| 10 | **问题** | `styles.css:125-138`、`:194-217`、`:701-705` | 库存页 ✓ 单滚动（`.app-main--split` + `[data-scroll-root]`）；销售记录 ✓；**报表页是双层**：`.app-main` 自己滚，单品表 `.glass-table-wrap{max-height:60dvh;overflow:auto}` 又滚一层，表内滚到底后 `overscroll-behavior:contain` 不链式传给外层，用户会觉得「卡住」（M-02）。各页底部留白：记账 172px（`:147`）、进货 96+80（`record.css:401-403`）、子页/报表 96px，均大于浮栏顶边 162/90px，未被遮 ✓。 |
| 11 | 通过 | `AppShell.tsx:869-877`、`record.css:86-101` | `editor` 是唯一入口状态，正常开单 / 编辑 / 补记 / 详情联跳都走它，`shellClass`/`mainClass` 每次渲染重算，退出即消失，无残留。补记与编辑用的 key 也隔离（`AppShell.tsx:543-549`）。 |
| 12 | **问题** | `record.css:112-128`、`styles.css:99-100`、`AppShell.tsx:246-252` | 子页返回入口 ✓（`sub` 时渲染 `back-btn`，46×46 玻璃胶囊）。但 `.app-nav` 有 `env(safe-area-inset-top)`，**开单页的 `.record-top` 没有**——`viewport-fit=cover`（`index.html:12`）已开启，刘海机 PWA 全屏下返回按钮顶到状态栏里（M-03，需真机确认遮挡程度）。 |
| 13 | 通过 | `kit.tsx:234-287`、`:342-360`、`:352-412` | 引用计数锁：只 0→1 上锁、1→0 还原；优先锁 `[data-scroll-root]`，其次 `.app-main`，开单页（`app-main--editor` 或 computed `overflow-y:visible`）退回锁 body（`:248-270`）。解锁清空 `position/top/width` 并 `scrollTo` 原位（`:283-286`）。嵌套确认框回栈顶只弹一层 ✓（`:385-390`）。 |
| 14 | 通过（真机复核） | `styles.css:161-166`、`:125-138` | `.app-main input/textarea/select{scroll-margin-block:120px}` 覆盖了所有页面内输入框（库存页输入框也在 `.app-main` 后代内）；Sheet 的输入框同理，其滚动容器是 `.glass-sheet__body`（`:658-661`）。**风险**：开单页固定底栏 `.record-actions`（`record.css:318-340`）在 `interactive-widget=resizes-content` 下会贴在键盘上沿再占 97px，可能压住正在编辑的金额框 → 第三节。 |
| 15 | **问题** | `StockPage.tsx:154-155`、`ProductPicker.tsx:85-88` | 库存页「搜不到」和「一个商品都没有」都显示「还没有商品」，搜错字会误以为货没了（M-08）；ProductPicker 已区分（「没搜到这个商品」+「看全部」），库存页没跟上。销售记录 ✓（`HistoryPage.tsx:144-155` 区分全空/区间空）；删到最后一单不会空列表（灰行还在）✓；「今天已录」/临期/单品表空态 ✓。 |
| 16 | **问题（轻）** | `record.css:53-68`、`styles.css:604-614`、`AppShell.tsx:187-195` | 数量输入框 56×44 ✓、± 44 ✓、分段按钮 44 ✓、状态灯 46×44 ✓、底栏按钮 44 ✓、行内删除 44 ✓、Sheet 关闭 44 ✓、Toast 动作 32+伪元素扩 12=44 ✓。**只有行内「撤销」宽度约 40px**（`link-btn` 只约束了 `min-height`）（L-01）。 |
| 17 | **问题** | `kit.tsx:378-383`、`:392-404` | `initialFocus="panel"` 后按 Tab 确实先到关闭按钮（面板是 `tabIndex=-1`，DOM 里下一个可聚焦就是 `__close`）✓；关闭后 `prevFocus.focus()` 回到触发按钮 ✓（含保存后自动开弹层那条，触发点已先 `focus`，`RecordEditor.tsx:130-136`）。但**从 panel 按下 Shift+Tab 会穿透模态**跑到背景页面的按钮上（陷阱只在 `activeElement===firstEl` 时才接，`:397-399`）（M-15）。 |
| 18 | **问题** | `AppShell.tsx:142-161`、`styles.css:483-491` | 形状+数字/符号 ✓（✓ / ! / 数字），删除行同屏给透明度+删除线 ✓（`.is-voided`）。但**「离线」和「未开启云同步」都是同一个空心灰环、都没有 mark**，肉眼完全同形同色，只能点开读 Toast 才知道是哪种（M-06）；强光下 `--yh-ink-4` 空心环也不易辨。 |
| 19 | **问题** | `ReportPage.tsx:376`、`:533`、`CloseSessionSheet.tsx:107`、`HistoryPage.tsx:64` | 「作废 / 我 / 老婆 / 切到深色」已从用户可见文案清零（仅 `HistoryPage.tsx:64` 注释里还有「作废」）✓。但单位不统一：报表临期行「剩 N **件**」、成本缺失「N **件**」、收摊检查「N **件**」，而商品单位是 `unitBase`（个/挂/支），旁边别的行都用 `qtyToStr` 显示「N 个」（M-09）。 |
| 20 | **问题（轻）** | `AppShell.tsx:908-923`、`RecordPage.tsx:78-100`、`StockPage.tsx:130-135`、`ReportPage.tsx:519-537`、`AppShell.tsx:895-906` | 一次性提示基本都走 Toast ✓。剩余常驻横幅 6 处：①记账页离线条（持续状态，合理）②跨天未结账卡（可「继续记」关掉，合理）③迁移失败（故障，合理）④**示例商品提示（一次性，却占一屏一条，建议改 Toast 或收进设置）**（L-10）⑤库存缺货条（持续状态，合理）⑥报表收款不平 / 成本缺失（异常，合理）。 |

## 二、发现的问题（按严重度）

### 高

**H-01｜清空数据第 3 步的「取消」= 清空本机** — `SettingsPage.tsx:597-605`（`cancelClearStep`）、`:740-761`（`ConfirmSheet` 未传 `cancelText`，默认「取消」，`kit.tsx:474`）
用户撞上：默认配置下云同步已开启 → 清空走到第 3 屏「同时清空云端账本？」，按钮是「一并清空云端 / 取消」。摊主想「先不清云端」→ 点「取消」→ **本机账本当场清空，且不可恢复**。
最小改法：`cancelClearStep` 只在 `clearStep<3` 时把 `clearStep` 归 0；第 3 步的 cancel 改成显式文案并需要二次确认，或直接改成三个平铺选项（只清本机 / 连云端一起清 / 不清了）。改动量：约 15 行，1 个文件。

**H-02｜箱 → 个 切回时用陈旧 `baseBefore`，数量与金额一起回退** — `useRecordDraft.ts:199-204`（`:201` 写入、`:203` 还原）
用户撞上：10 个 → 点「箱」→ 点两次 `+`（2 箱 = 20 个）→ 点「个」→ 数量变回 **10 个**，金额被 `syncAmount` 重算成 10 个的价。用户以为只是换单位显示，实际少卖一半。
最小改法：`baseBefore` 改为「当前单位换算回基本单位」再切，即始终 `qtyBase` 即真值，切回 base 时不再还原快照（`qtyBase: l.qtyBase`）；若要保留「切箱前是 3 个」的语义，就在箱模式下每次改数量时同步刷新 `baseBefore = qtyBase`。改动量：3~5 行 + 1 个用例。

### 中

**M-01｜不足一箱时点「箱」，数量被放大成一箱且无提示** — `useRecordDraft.ts:200`
3 个 → 点「箱」→ 变成 10 个（金额 ×3.3）。最小改法：`boxes = Math.floor(...)`，若为 0 则按钮置灰/Toast 提示「不足 1 箱」，不做 `Math.max(1, …)` 的静默放量。改动量：5 行。

**M-02｜报表单品表双层纵向滚动** — `styles.css:701-705` + `:125-138`
表格内滚到底后 `overscroll-behavior:contain` 把父层滚动链断掉，用户在表格上方怎么滑都不动页面。最小改法：报表页也走 `data-scroll-root`（给 CostCard 之外的列表区独立的滚动根），或把 `.glass-table-wrap` 改成 `max-height:none; overflow-x:auto`，纵向交给 `.app-main`（表头 sticky 会退化为随页滚，需一并确认）。改动量：1 处 CSS + 1 处 `data-scroll-root`，约 10 行。

**M-03｜开单页顶栏缺 `safe-area-inset-top`** — `record.css:112-128` vs `styles.css:99-100`
刘海机 PWA 全屏（`viewport-fit=cover`，`index.html:12`）时 `.record-top` 的返回按钮贴在状态栏/刘海下方，可能点不到。最小改法：`.record-top` 的 `padding-top` 加 `env(safe-area-inset-top, 0px)`（照抄 `.app-nav`）。改动量：1 行。

**M-04｜数量输入框吞全角数字、把小数放大 10 倍** — `RecordLineCard.tsx:120-124`
`replace(/\D/g,'')` 对 `５`（全角）、`3.5` 都做了不可见的删除/拼接：前者变空（失焦落 1），后者变 `35`。最小改法：先做全角转半角（`charCodeAt` − 0xFEE0），再对 `.` 单独处理——有小数点时提示「数量填整数」，或直接 `blur()` 并 Toast。改动量：10 行左右。

**M-05｜输入中切换单位/± 依赖 blur 先于 click** — `RecordLineCard.tsx:111-143`
逻辑本身自洽（见第 2 项），但 iOS Safari 点 button 不保证移动焦点，若 click 先于 blur，会出现「显示 3、实际 4」或「切箱后按个位数落库」。最小改法：`±`/单位按钮的 `onPointerDown` 里先 `document.activeElement.blur()`（或主动 `setEditing(false)` + 用 `qtyText` 归一化后提交），把顺序钉死。改动量：8 行。需真机复核（第三节）。

**M-06｜同步状态灯「离线」与「未开启云同步」视觉完全相同** — `AppShell.tsx:142-161`
两者都是 `--yh-ink-4` 空心环且无 mark，但后果完全不同（一个会自动补发，一个永远不备份）。最小改法：`off` 用虚线环或加「—」mark，并给两种状态不同 `title`。改动量：6 行。

**M-07｜键盘 Enter 点行内「撤销」会同时打开详情** — `HistoryPage.tsx:205-215` + `kit.tsx:151-163`
`<li>` 的 `onKeyDown`(Enter/Space) 会接到按钮冒泡上来的 keydown，`e.preventDefault()` 后调 `onClick()` → 撤销 + 打开该单详情（此时已恢复）。最小改法：`rowProps` 的 keydown 里加 `if (e.target !== e.currentTarget) return;`。改动量：1 行。

**M-08｜库存页搜索无结果 = 「还没有商品」** — `StockPage.tsx:154-155`
搜错字或用了别名，会以为货丢了。最小改法：照 `ProductPicker.tsx:86-88` 的三分支（有查询词→「没搜到」+「看全部」）。改动量：10 行。

**M-09｜部分文案把基本单位写成「件」** — `ReportPage.tsx:376`、`:533`、`CloseSessionSheet.tsx:107`
商品基本单位是「个/挂/支」，同屏旁边用 `qtyToStr` 显示「个」，数字口径一致但单位词不一致。最小改法：能拿到 `Product` 的地方用 `unitBase`，拿不到的写「基本单位」或「个（按基本单位）」。改动量：3 处，约 6 行。

**M-10｜设置项 onBlur 保存失败无任何反馈** — `SettingsPage.tsx:146-148`、`:159`、`:173`、`:183`
`saveText` 未 catch，`setSetting` 抛错（配额/事务冲突）会成为 unhandled rejection，用户以为已保存，编号其实没落库。最小改法：`saveText` 内 try/catch + `onDone('没存上：…','error')`（`MachineSection` 需要接 `onDone`）。改动量：15 行。

**M-11｜操作人编号留空 → 两台手机都叫「本机」** — `App.tsx:50-53` + `SettingsPage.tsx:163-176`
`operators[0]` 三级回落 `operatorSelf → deviceName → '本机'`；`deviceName` 默认也空（`:159` 只在 blur 时兜底），于是两人所有单在历史/报表里都显示「本机」。最小改法：编号框加 `hint` 说明「留空就用设备名，两台别都留空」，并在留空且 `deviceName` 也空时于顶栏提示；或直接禁止留空（blur 时回填 `001`）。改动量：10 行。

**M-12｜编辑旧单时 operator 不归一化** — `useRecordDraft.ts:82`（`initial` 直传）+ `recordDraft.ts:162`
把「我/老婆」时代的单改一下，保存后 operator 仍是旧字符串，与新的 001/002 口径混在一张表里。最小改法：`initialDraftState` 里对 `initial.operator` 也走 `operators.includes(...)` 归一化（或在 `buildInput` 里统一映射）。改动量：3 行。

**M-13｜主题开关夹在表单中间、误触无撤销** — `SettingsPage.tsx:186-199`
它是「本机与操作人」卡里最后一个元素，正好在「临期预警」输入框失焦后的落点上；一按整屏变色，无 Toast、无「恢复上一个」。最小改法：拆出「外观」小卡放到卡列表末尾，并在切换后给一条带「切回深色」动作的 Toast。改动量：20 行。

**M-14｜进货批次删除不可撤销** — `PurchasePage.tsx:129-147`（对比 `RecordEditor.tsx:154-170` 的行内撤销）
删错一条进货会改掉 FIFO 成本与毛利，用户只能重新录入（批号/日期都丢了）。最小改法：给 `doDeleteBatch` 的成功 Toast 加「撤销」（重放 `createBatch`，沿用原 id 需 repo 支持）。改动量：25 行（含 repo 一个 soft-undo 参数）。

**M-15｜`initialFocus="panel"` 时 Shift+Tab 穿透模态** — `kit.tsx:392-404`
从面板按 Shift+Tab，焦点跑到背景页的按钮上（陷阱只在 `firstEl`/`lastEl` 两端接）。最小改法：`if (!panelRef.current?.contains(document.activeElement)) { e.preventDefault(); firstEl.focus(); }` 前置判断。改动量：4 行。

**M-16｜保存后的「撤销」Toast 会被下一条 Toast 顶掉** — `AppShell.tsx:368-375`（`showToast` 直接覆盖）
连开两单时，第一单的撤销入口立刻消失，只剩 0 秒可用窗口。最小改法：`showToast` 里若当前 toast 带 action 且未过期，排队而不是覆盖（或把「撤销」升级成底栏常驻 6 秒条）。改动量：20 行。

### 低

- **L-01｜行内「撤销」触控宽度 ~40px** — `record.css:53-68`：只给了 `min-height`，加 `min-width: var(--yh-touch-min)`。（1 行）
- **L-02｜撤销失败用 warning 语气** — `HistoryPage.tsx:100`：应 `'error'`。（1 行）
- **L-03｜校验出错时聚焦的是金额框** — `useRecordDraft.ts:251`：数量错误也聚焦金额框；赠品行不渲染金额框，`amountRefs[bad]` 为 null → 只出红字不定位。建议按 `lineError` 区分聚焦目标。（8 行）
- **L-04｜行内撤销可连点** — `HistoryPage.tsx:211`：无 busy 守卫，幂等但会连弹 Toast。（3 行）
- **L-05｜撤销不存在的记录静默成功** — `repo.ts:939-941`：找不到就 return，界面仍提示「已撤销删除」。（3 行）
- **L-06｜`useTheme` 写 localStorage 无 try/catch** — `AppShell.tsx:88-93`：隐私模式下抛错会跳过 `theme-color` 更新。（3 行）
- **L-07｜数量超 4 位粘贴静默截断** — `RecordLineCard.tsx:120`：`12345`→`1234`（差 10 倍的另一头）。建议截断时 Toast 提示上限。（4 行）
- **L-08｜`SETTING_LABELS` 仍留「操作人 A/B」死文案** — `SettingsPage.tsx:62-66`：旧 key 已不再由设置页写入，合并预览里这两行是死代码。（5 行）
- **L-09｜进货数量允许小数后静默取整** — `PurchasePage.tsx:66-67`：`1.5 个` → `Math.round` 成 2。（4 行，建议改成整数输入或报错）
- **L-10｜示例商品提示用常驻横幅** — `AppShell.tsx:908-923`：一次性提示，占掉记账页首屏一条。建议改 Toast + 设置页入口。（10 行）
- **L-11｜数量每敲一字都写一次草稿** — `useRecordDraft.ts:108-125`：`setDraft` → localStorage，低端机连打 4 位会卡。建议 debounce 200ms。（6 行）
- **L-12｜`amountRefs` 按数组下标存** — `RecordEditor.tsx:273-275`：删行后高位的陈旧引用留着（当前不影响功能）。（4 行，改用 `key` 索引）

## 三、需要真机才能定的 3 条

1. **弹层锁 body 在开单页的观感**（`kit.tsx:248-270`）：开单页 `scrollLockTarget()` 返回 null → 退回 `body{position:fixed;top:-Y}`。需在 iOS Safari / PWA 上确认：①打开「选商品」时整页有没有跳一下；②关闭后 `scrollTo` 是否回到原位置；③键盘弹起时 `.glass-sheet` 的 footer「完成（回单据）」是否被键盘盖住（`--yh-sheet-max-height:90dvh`）。
2. **输入框 blur 与 ± / 单位按钮 click 的先后**（`RecordLineCard.tsx:99-147`）：iOS Safari 点 button 不一定夺焦。若 click 先于 blur，会出现「输入 3 显示 3、实际 4」或「切箱后按个位数落库」。需真机连点验证；若复现，按 M-05 在 `onPointerDown` 里强制归一化。
3. **刘海机 PWA 全屏的顶/底安全区**（`record.css:112-128`、`:318-340`）：`.record-top` 未加 `env(safe-area-inset-top)` 时返回按钮离状态栏的实际距离；以及键盘弹出时固定底栏（97px）与金额输入框的重叠程度。两条都只能在 iPhone（含刘海、含 320pt 窄屏）实测定论。
---

## 四、实测回归与修复（2026-11-11）

390×844 真机尺寸实测（`docs/selfcheck-runtime-20261111.md`）推翻了第一条、确认了第二条；两项均已修，复测通过。

### 1）不足 1 箱时点「箱」被禁用 → 改为「允许切箱 + 一次 Toast 提示」（M-01 回退）

- 实测：`1 挂` 时「箱」按钮 `disabled=true`，**切不到箱模式**，必须先手改成 20 挂再切 —— 比原来的静默放大更难用。
- 修复：`src/ui/RecordLineCard.tsx:143-158` 去掉 `disabled`/`aria-disabled`/`title`；`src/ui/useRecordDraft.ts:302-340` 的 `switchUnit` 改为返回 `{ ok, bumpedToBox }`，不足 1 箱时按 **1 箱**计；`src/ui/RecordEditor.tsx:286-299` 仅在 `bumpedToBox` 时给非模态 Toast「已按 1 箱（20挂）计，可再调整数量」。
- 复测：`箱` 可点；1 挂 → 1 箱（标价 ¥500.00 = 25.00×20，`qtyBase=20`）；Toast 出现一次，再点「箱」不重复。
- 结论：**「不静默改写数量」的初衷保留**（改写必告知），**「不阻断切换」也成立**。

### 2）Toast 的 action 按钮 72×32 → 72×44（a11y 回归）

- 实测：a11y 第 [4] 段「记账首页无小于 44 的可见控件」失败，唯一一项是 `知道了 72x32`（示例商品 Toast 的操作按钮）。
- 修复：`src/styles.css:1124-1143` 给 `.glass-toast .glass-toast__action` 加 `min-height: var(--yh-touch-min, 44px)`（只抬纵向）、`.glass-toast__close` 同步补成 44 圆。
- 复测：按钮 `72×44`，Toast 容器 `78px`（< 96px），第 [4] 段 **0 个未达标**，a11y 五段全过。

### 3）第 9 项「弹层锁滚」→ 断言口径问题，非缺陷（不改实现）

脚本直接 `scroller.scrollTop += 200` 在 `overflow:hidden` 容器上仍能改值（Chromium 保留程序化滚动端口），而真实触摸上滑与关闭还原均正常（400 → 400 → 400）。**已在 runtime 报告标注为断言口径问题，本报告一并更正上一轮第 13 项「通过」的口径依赖。**

### 门禁（本轮）

`tsc --noEmit` 0 error ｜ `pnpm test` 12 文件 / 134 通过 ｜ `pnpm build` 成功 ｜ `a11y-check` 5 段全过（[4] 触控目标通过）。
