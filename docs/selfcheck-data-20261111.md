# 数据层回归自检（2026-11-11）

> 只读审计。对象是本轮未提交的 6 项数据层修复 + `operatorSelf`：
> ①墓碑删除 `SKIP_SETTINGS` 白名单 ②拉取 5 分钟重叠窗口 ③每日首次全量重放
> ④`keep-local`/`conflict` 回推 + 30s 节流 + 防回声 ⑤`writeWithOutbox`（21 处）
> ⑥`parseRemoteRecord` 入站校验。
>
> 目标：**这些修复自身引入的新问题**。`docs/review-20261110/backend.md` 已记录且本轮已修的条目（M-5 墓碑白名单、L-6 冲突留痕只写不消费等）不重复报告，只在必要时作为背景引用。
>
> 结论依据均为工作区当前代码（`src/db/sync.ts` 1344 行、`src/db/repo.ts` 1019 行）。

## 一、12 项逐一结论

| # | 核实项 | 结论 | 代码依据 |
|---|---|---|---|
| 1 | 重叠窗口 × 每日重放叠加 | **有问题（间接）**：同一批行确实会应用两次，但 `bulkPut`/`delete` 幂等，**不会写坏数据**；真正的问题是**重放轮被禁止回推**，导致「5 分钟窗口之外被对方旧版本覆盖」的记录永远不收敛（详见 M-1） | `sync.ts:1244-1258`、`sync.ts:984`、`sync.ts:1209-1215` |
| 1a | `persistCursor:false` 是否让重放期间远端新写入的行永远错过 | **不会**：重放不动水位，下一轮增量从**增量轮持久化的游标**（早于重放终点）开始，那些行 `updated_at` 必然 > 游标 → 下一轮拉到 | `sync.ts:1192-1193`、`sync.ts:1170-1172` |
| 1b | `applyRemoteBatch` 幂等是否覆盖 line/order 的 delete + 再 put | **单条记录覆盖**（同一 `kind:id` 云端只有一行；`putRow`/`deleteRow` 互斥维护 `puts`/`deletes`，最终先删后写）；**跨页的「order 墓碑 + 其后 line 行」不覆盖** → 孤儿明细（M-4） | `sync.ts:792-812`、`sync.ts:909-924` |
| 2 | 重放 `capped` 判定 | **有问题（H-1）**：半页**不会**误判（`rows.length < PAGE_SIZE` 先 `break`，早于赋值）；但**第 20 页刚好满页且后面没有数据**时 `capped=true` 恒成立 → 每天标记落不下去，实际是**每一轮同步都从 0 重放**；且 1 万行之后的旧行因重放每次都在同一处分页截断而**永远补不到** | `sync.ts:1196-1198`、`sync.ts:1227-1233`、`sync.ts:1250-1258` |
| 3 | 重放与 outbox 的交互 | **没问题**：pending 过滤在 `applyRemoteBatch` 入口，与 `opts.replay` 无关；重放轮本地 pending 记录同样被排除，不会被远端旧值覆盖 | `sync.ts:945-951`（在 959 事务之前、984 回推之前） |
| 4 | 回推节流表 | **没问题**：`__resetSyncFlagsForTest` 明确 `lastRepushAt.clear()`；`pruneRepushThrottle` 只删 `now - at >= 30s` 的键，而 `now` 在写入前捕获、刚写入的键 `at === now` → **不会误删**。仅剩 L-3（先记节流后入队、刷新即清零） | `sync.ts:709-713`、`sync.ts:738-743`、`sync.ts:765-769` |
| 5 | 防回声比较 | **没问题（不会无限回推）**：`canonicalJson` 键排序 + 丢 `undefined`，所以键顺序/`undefined` 不产生误判；`null` vs 缺失、`1` vs `"1"`、数组顺序差异判为「不同」→ 只多推**一轮**即收敛（推送用 `JSON.stringify` 落地，回读后 canonical 相等），不会成环 | `sync.ts:719-729`、`sync.ts:732-735`、`sync.ts:407-413` |
| 6 | 回推写入放大 | **有界但会慢循环**：outbox 主键 `${kind}:${id}`（`buildPut` upsert），同一记录永远最多 1 行 → **outbox 不会持续增长**；但两端业务时间相同且内容不同时会每 30s 对推一次、无终止条件，且每轮 `conflicts.bulkAdd` 一条（后者是既有 L-6，不算新回归） | `outbox.ts:27-35`、`sync.ts:757-776`、`sync.ts:848-864`、`sync.ts:922` |
| 7 | 事务化遗漏 | **有问题（L-1）**：`db.outbox.put/bulkPut` 仅出现在 `outbox.ts:42/48/66`；`enqueueInTx` 唯一调用点 `repo.ts:50` 在事务内。业务写入绕过 `writeWithOutbox` 的有 2 处：`seed.ts:47-58`、`merge.ts:106-165 / 173-194`（后者事务清单**不含 `db.outbox`**），另有 3 处属有意设计（`ensureDeviceId`、`clearAllData`、`sync.ts:508`） | 见下「7 项明细」 |
| 8 | 事务化死锁风险 | **没问题**：21 处 `write()` 回调**没有任何嵌套 `db.transaction`**；逐个核对写集 ⊆ 声明表（见「8 项明细」）。`ensureOpenSession` 是在 `saveRecord` 开事务**之前**调用（`repo.ts:504`），不是嵌套 | `repo.ts:43-53`、`repo.ts:501-524` |
| 9 | `syncWanted()` 时机 | **没问题**：位于 `await db.transaction(...)` 之后（`repo.ts:48-52`），事务抛错时不会执行；连续触发由 `useSync` 的 700ms 去抖合并（`useSync.ts:85-88`），不会形成请求风暴 | `repo.ts:48-52`、`useSync.ts:85-88` |
| 10 | `parseRemoteRecord` 宽严 | **过严有问题（M-3）**：枚举白名单会把「新版本新增的分类/支付方式/调整类型」**整行判非法**，旧客户端永久丢弃且不会自愈；**过松**：`{...parsed, id}` 把多余字段原样入库并会随下次编辑再推给其它设备（L-5）。赠品行**判断正确**：`qtyBase > 0` 且 `amountFen = 0` 放行 | `sync.ts:597-603`、`sync.ts:658-682`、`sync.ts:901`、`sync.ts:630-644` |
| 11 | `SKIP_SETTINGS` 扩展 | **基本没问题**：`pull` 两条路径都过滤（墓碑 834 行、put 883 行），不写库也不进 unknown kind。**但仍会入队一条注定被丢弃的行**：设置页 `setSetting('operatorSelf')` → `writeWithOutbox` → 发件箱写入；推送时 `buildPushPayload` 跳过、`bulkDelete` 照删，所以不会「每轮推一个」，只是每次编辑浪费一条 + 一次网络往返（L-2） | `sync.ts:65-70`、`sync.ts:425`、`sync.ts:487`、`outbox.ts:91-92` |
| 12 | 旧数据兼容 | **有问题（M-2）**：`operator` 是**随单存储**的（`HistoryPage.tsx:186`、`RecordPage.tsx:180` 直接读 `o.operator`），所以**同一单在两台手机上显示一致**，题目担心的显示错乱不成立；真正的问题是**没有 `operatorA/B → operatorSelf` 迁移**，老设备新单归属变「本机」，且 `merge.ts` 的跳过集不含 `operatorSelf` → 导入备份会把本机编号覆盖成对方的 | `App.tsx:50-53`、`SettingsPage.tsx:143/173`、`merge.ts:153-158` |

### 7 项明细（outbox 入队调用点与事务范围）

| 位置 | 调用 | 事务范围 | 判定 |
|---|---|---|---|
| `src/db/outbox.ts:42` | `db.outbox.put`（`enqueue`） | 自身独立写，无外层事务 | 仅测试调用；不涉及业务表 ✔ |
| `src/db/outbox.ts:48` | `db.outbox.bulkPut`（`enqueueMany`） | 无外层事务 | 调用方 `sync.ts:772`（回推，事务提交后）、`outbox.ts:92`（整库标记）✔ |
| `src/db/outbox.ts:66` | `db.outbox.bulkPut`（`enqueueInTx`） | **必须在事务内** | 唯一调用点 `repo.ts:50`，位于 `db.transaction('rw', [...tables, db.outbox])` ✔ |
| `src/db/outbox.ts:91-92` | `enqueueAllLocal → enqueueMany` | 只读业务表 + 写 outbox，无业务写入 | 设计如此 ✔（但会把 SKIP 设置也入队，L-2） |
| `src/db/seed.ts:47-58` | `db.products.bulkPut` + `db.settings.put('seeded')` | 自有事务 `[products, settings]`，**不入队** | 绕过（L-1）：示例商品/`seeded` 不会推送，除非之后 `markAllDirty` |
| `src/db/merge.ts:106-165` | `importMerge` 全部业务表 | 自有事务，**清单不含 `db.outbox`** | 绕过（L-1）：靠调用方 `afterMerge()`；src 内已无该函数调用点（仅测试） |
| `src/db/merge.ts:173-194` | `replaceAll` | 同上，且之后关闭云同步 | 可接受（整库替换后禁用同步）✔ |
| `src/db/repo.ts:80-87` | `ensureDeviceId` 写 `deviceId` | 自有事务 | 有意设计（`deviceId` 属 SKIP）✔ |
| `src/db/repo.ts:996-1017` | `clearAllData` 清 7 张表 + `setSetting×2` + `outbox.clear()` | 分三段 | 有意设计（清空后由 `clearCloud` 传播）✔ |
| `src/db/sync.ts:508` | `mergeUnknownKinds` 写本机诊断键 | 在 `applyRemoteBatch` 事务内 | 有意设计（`sync-unknown-kinds` 属 SKIP）✔ |

### 8 项明细（21 处 `write()` 的写集 vs 声明表）

`setSetting`[settings]、`ensureBootstrapSettings`[settings]、`createProduct`[products]、`updateProduct`[products]、`deleteProduct`[products]、`createBatch`[batches]、`deleteBatch`[batches]、`ensureOpenSession`[sessions]、`saveRecord`[orders,lines]、`updateRecord`[orders,lines]、`deleteRecord`[orders,lines]、`undoPatchedRecord`[sessions,orders,lines]、`closeSession`[sessions]、`reopenSession`[sessions]、`addPatchedRecord`[sessions,orders,lines]、`refreshSessionSummary`[sessions]、`writeClosedSummaries`[sessions]、`migrateSessions`[sessions,orders,settings]、`voidOrder`[orders]、`restoreOrder`[orders]、`createAdjustment`[adjustments] —— **写集全部 ⊆ 声明表，且无一在回调内开事务**。

> 附：`migrateSessions`（`repo.ts:900-916`）写了 `sessionsMigrated` 设置却**没有把它登记进 `items`**，是「同事务入队」的唯一内部漏项（该键是本机迁移标记，是否该同步本身存疑，见 L-1 备注）。

## 二、确认的回归/风险

> **修复状态（2026-11-11，任务 35）**：H-1、M-1~M-4、L-1~L-5 全部已修，逐条修复点见
> `docs/代码异味基线-20261110.md` 第十六节；新增 7 条回归测试（用例总数 127 → 134）。
> 本文以下内容保留审计时的原始判定，未随代码回改。

### H-1｜`capped` 判定导致「每轮全量重放」+ 1 万行之后的旧行永久补不到

| 项 | 内容 |
|---|---|
| 级别 | **High**（账本达 `MAX_PAGES × PAGE_SIZE = 10 000` 行即触发；按 2 人摊 3–5k 单推算，两个春节季内可达） |
| 位置 | `src/db/sync.ts:1196-1198`、`:1227-1233`、`:1250-1258` |
| 代码 | `if (rows.length < PAGE_SIZE) break;` → `if (page === MAX_PAGES - 1) capped = true;`；`dailyReplay` 里 `if (pass.capped) { console.warn(...); return; }`（**不落 `lastReplay`**）；`pull()` 每轮都因 `lastReplayDate() !== localDate()` 再次进入 `dailyReplay` |
| 触发场景 | ①账本 ≥ 10 000 行（第 20 页恰好满页，无论后面还有没有数据）；②或清空/首次全量时同样满页 |
| 后果 | ①**每一轮同步**都从 0 重放 20 页（约 1 万行）→ 流量/CPU/耗电翻 20 倍，Supabase egress 与 IndexedDB 写入持续放大；②`capped` 时重放**不做尾部补读**，且分页顺序确定（`updated_at.asc,id.asc`）→ **第 20 页之后的旧行永远落在重放截断点之后**，而这批行正是「设备时钟偏了几小时/几天」时唯一能救回来的数据 → 自愈机制在数据量最大时恰好失效，且无任何用户可见提示（只有 `console.warn`） |
| 最小修复 | ①满页时多做一次「探测页」：`page === MAX_PAGES-1 && rows.length === PAGE_SIZE` 时用 `nextCursor(rows)` 再请求 1 条 `limit=1`，为空才算 `capped`；或②把 `capped` 与「今天已重放」解耦为两个标记（`lastReplayCursor`），超页时把**已扫到的游标**持久化，下一轮从该游标续扫而不是每次回 0；③至少把 `capped` 计入 `SyncStatus`/设置页提示，不要静默 |

### M-1｜重放轮禁回推 → M-2（`keep-local` 回推）只覆盖 5 分钟窗口

| 项 | 内容 |
|---|---|
| 级别 | **Medium** |
| 位置 | `src/db/sync.ts:984`（`if (!opts.replay) await repushLocalVersions(...)`）vs `:1172`（增量轮起点 = 游标 − 5min）、`:1209-1215`（重放才是兜底全量） |
| 代码 | 增量轮只回看 `OVERLAP_MS=5min`；`applyRemoteBatch` 在 `replay:true` 时把 `planned.conflicts = []` 且**跳过 `repushLocalVersions`** |
| 触发场景 | 对方用旧版本覆盖了某条记录（`keep-local`），且该远端行 `updated_at` 早于本机游标 − 5 分钟（例如对方离线补推、或本机离线一晚后恢复） |
| 后果 | 只有每日重放能读到这条行，而重放**恰好**不回推 → 云端永久停在旧版本；换手机/重装从云端恢复时，已作废的单会复活、补记会丢失（正是 M-2 要解决的问题，但在 >5 分钟的场景里仍然存在）。重放同时把 `conflicts` 清空，连「曾经冲突过」的痕迹都不留 |
| 最小修复 | 重放轮**不再整体禁回推**，改为「只对 `decision === 'conflict'`（或 `remoteTime > 0 && 内容不同`）登记回推候选」，并沿用 30s 节流 → 量级与增量轮同阶；或把重放轮的候选写入限长的 `localStorage` 队列，下一轮增量统一入队 |

### M-2｜`operatorSelf` 没有迁移，且导入合并会覆盖本机编号

| 项 | 内容 |
|---|---|
| 级别 | **Medium**（立即可见的产品回归，非数据损坏） |
| 位置 | `src/App.tsx:50-53`（`self \|\| deviceName \|\| '本机'`）、`src/ui/pages/SettingsPage.tsx:143/173`（只暴露 `operatorSelf`，旧 `operatorA/B` 无 UI）、`src/db/merge.ts:153-158`（跳过集 = `deviceId/deviceName/operatorA/operatorB`，**缺 `operatorSelf`**） |
| 触发场景 | ①老用户升级：`operatorA='我'`、`operatorB='老婆'`、`operatorSelf` 不存在；②从另一台手机的备份 `importMerge` |
| 后果 | ①两台老手机的新单 `operator` 变成 `'本机'`（或 `deviceName`），与历史单里的 `'我'/'老婆'` 分裂成两种标签，报表/历史里同一个人出现两套名字；`closeSession` 的 `closedBy` 同样是 `'本机'`（`CloseSessionFlow.tsx:55`）；②导入备份会把本机 `operatorSelf` 覆盖成对方的编号，之后本机所有新单都记到对方名下（比 ①更严重） |
| 最小修复 | ①在 `ensureBootstrapSettings`/启动迁移里补一步 `operatorSelf ??= operatorA`（`deviceId` 维度判断即可，不写回 `operatorA`）；②`merge.ts:153-158` 的 `skip` 补 `SETTING_KEYS.operatorSelf`；③`SKIP_SETTINGS` 已有该项，无需再动 |

### M-3｜入站枚举白名单对「新版本新增值」是硬拒绝 → 旧客户端静默丢数

| 项 | 内容 |
|---|---|
| 级别 | **Medium**（前向兼容；一旦出现新分类/新支付方式就立刻触发） |
| 位置 | `src/db/sync.ts:597-603`（`ENUM_FIELDS`）、`:672-679`（值域外 `return null`）、`:893-902`（`warnInvalidRemote` 后 `break`，不写库） |
| 代码 | `if (typeof value !== 'string' \|\| !allowed.includes(value)) return null;` → 调用方只写一条本机诊断 `拉取到非法数据已跳过` |
| 触发场景 | 未来版本新增 `category='礼花弹'`、`payMethod='card'`、`adjustment.type='transfer'`，或用户在控制台修正了历史脏值 |
| 后果 | 旧客户端**整行**丢弃该记录且每次拉取都重试同一行（每次只覆盖写一条 warn），数据永远不落地；反过来新客户端会把旧客户端的正常记录也判非法。这类「合法但值域未知」的数据被当脏数据，是可自愈性问题（脏数据本应由 `keep-local` 修回，但这里连写都不写） |
| 最小修复 | 枚举校验从「整行拒绝」降级为「记诊断 + **保留原值**」，只对参与计算的字段（`num`/`bool`）保持硬拒绝；或对未知枚举值走 `keep-local` 并登记回推候选，让本机正确版本覆盖云端 |

### M-4｜order 墓碑与其后的 line 行跨页时不幂等 → 孤儿明细

| 项 | 内容 |
|---|---|
| 级别 | **Medium** |
| 位置 | `src/db/sync.ts:814-827`（`dropLinesOfOrder` 只清「同批次已入队的 puts」和内存 `current`）、`:909-918`（级联删只在 `plan.deletes` 里还有该 order 时执行一次） |
| 触发场景 | 设备 A 删除订单（order + lines 墓碑，`updated_at=t1`），设备 B 在 t2>t1 编辑同一单的明细并推送；重放/增量按 `updated_at.asc` 先应用墓碑、后应用 B 的 line 行 |
| 后果 | 父单已删、明细被重新写入 → 孤立 `line` 行。报表按 `sessionReport` 统计时 `line` 找不到 order 的路径可能被丢弃或计入成本（`fifoAllocate` 按 `orderId` 关联），历史成本与库存可能偏；且该孤儿行会被再次推送传播到其它设备。重放从 0 全量走一遍，等于**每天重新制造一次历史竞态现场** |
| 最小修复 | `applyPlannedChanges` 写 puts 前，对 `line` 的 `orderId` 做一次存在性检查（`db.orders.bulkGet(orderId)`，缺失则跳过并记诊断）；或在 `planRemoteChanges` 里维护「本批次/本会话已墓碑的 orderId 集合」，`putRow('line', …)` 时直接跳过 |

### L-1｜业务写入绕过 `writeWithOutbox`：`seed.ts` / `merge.ts`

| 项 | 内容 |
|---|---|
| 级别 | **Low** |
| 位置 | `src/db/seed.ts:47-58`（`products.bulkPut` + `seeded`，无入队）；`src/db/merge.ts:106-165`（事务清单不含 `db.outbox`）、`:173-194` |
| 后果 | 示例商品与 `seeded` 永不推送；`importMerge` 若调用方忘记 `afterMerge()`（当前 src 内已无调用点，只剩测试与 e2e 脚本），合并结果永不推送 —— 正是 M-1 事务化要消除的那类窗口，只是残留在这里 |
| 最小修复 | `seedIfEmpty` 改为 `writeWithOutbox([products, settings], …, [ …sample products, seeded ])`（`seeded` 若属本机标记，就加进 `SKIP_SETTINGS`）；`importMerge`/`replaceAll` 要么把 `db.outbox` 纳入事务并逐表登记，要么在函数内部直接 `await markAllDirty()`，不要依赖调用方 |

### L-2｜`SKIP_SETTINGS` 仍会入队（`enqueueAllLocal` + `setSetting('operatorSelf')`）

| 项 | 内容 |
|---|---|
| 级别 | **Low** |
| 位置 | `src/db/outbox.ts:91-92`；`src/ui/pages/SettingsPage.tsx:146-148/173`；消费端 `src/db/sync.ts:425` + `:487` |
| 后果 | 每次改 `operatorSelf` 都会写一条发件箱行，推送时被 `buildPushPayload` 跳过、再被 `bulkDelete` 删掉 → 多一次无意义同步往返；每次 `markAllDirty` 会入队 4 条 SKIP 键。**不会**造成「每轮都推一个被忽略的键」（行会被删掉），也不会写云端 |
| 最小修复 | `enqueue`/`enqueueMany`/`enqueueInTx` 入口统一过滤 `SKIP_SETTINGS`（`kind === 'setting' && SKIP_SETTINGS.has(recordId)` 直接 return），让「不该同步」在入队处就断掉 |

### L-3｜回推节流表：先记节流后入队；且刷新页面即清零

| 项 | 内容 |
|---|---|
| 级别 | **Low** |
| 位置 | `src/db/sync.ts:765-775` |
| 代码 | `lastRepushAt.set(key, now)` 在 `await enqueueMany(rows)` **之前**；`catch` 只 `console.warn`，不回滚节流标记 |
| 后果 | 入队失败（配额/库被占用）的记录会被静默节流 30s；模块级 Map 刷新即清空，两台设备在页面反复刷新时可以突破 30s 节流（真·对推加速），但 outbox 仍按主键去重，不会膨胀 |
| 最小修复 | 把 `lastRepushAt.set` 移到 `enqueueMany` 成功之后（失败时不节流，下一轮重试）；如需跨刷新节流，把 `lastRepushAt` 落 `localStorage` 并做限额裁剪 |

### L-4｜`pulled` 统计口径与注释不符（诊断误导）

| 项 | 内容 |
|---|---|
| 级别 | **Low** |
| 位置 | `src/db/sync.ts:1146-1148`（注释「本轮实际应用的远端行数」）vs `:1189-1190`（`pulled += dataRows.length`，在 pending/unknown/非法行过滤**之前**） |
| 后果 | 日志「全量重放完成，已重放 N 行」与设置页展示会虚高；排查「为什么没拉到某条」时被误导（实际被 pending 或 `parseRemoteRecord` 丢掉了） |
| 最小修复 | 让 `applyRemoteBatch` 返回实际写入/删除条数（`plan.puts`/`plan.deletes` 计数），`pulled` 累加该值；被跳过的行单独计数并写入诊断键 |

### L-5｜多余字段原样入库并二次传播

| 项 | 内容 |
|---|---|
| 级别 | **Low** |
| 位置 | `src/db/sync.ts:901`（`putRow(row.kind, id, { ...parsed, id })`，而 `parsed === row.data` 原对象） |
| 后果 | 远端 `data` 里的任意多余键（含非法嵌套结构的 `summary`，只校验 `obj`）会落进 IndexedDB；本机后续编辑该记录时会原样推回云端 → 脏字段跨设备传播。当前所有 TS 接口字段已覆盖校验，因此只影响「未来字段/手工写入」 |
| 最小修复 | 按 kind 做字段白名单投影（`pick(data, FIELDS[kind])`），或至少在 `putRow` 前只保留 `REMOTE_SCHEMAS[kind]` 的 required+optional 键 |

## 三、需要补的测试用例

| # | 测试名（建议文件） | 断言 |
|---|---|---|
| 1 | `每日重放：账本恰好 MAX_PAGES×PAGE_SIZE 行时不落今日标记`（`tests/sync-cursor.test.ts`） | 构造 10 000 行远端行 → `syncNow` 后 `localStorage['yh-sync-last-replay']` 为 `undefined`，且第二轮**仍从 0 请求**（`pullUrls` 第 2 轮无 `updated_at`/`or` 参数）——先暴露 H-1，修复后断言「探测页为空则落标记」 |
| 2 | `重放轮也应回推 5 分钟窗口外的 keep-local 行`（`tests/sync-inbound.test.ts`） | 远端行 `updated_at = now - 1h`、`record_updated_at < local.businessTime`、内容不同 → `syncNow` 后 `await db.outbox.get('order:r1')` 为真（当前实现为假 → 先红后修，对应 M-1） |
| 3 | `parseRemoteRecord：未知分类值的记录不得整行丢弃`（`tests/sync-inbound.test.ts`） | 远端 product `data.category='礼花弹'`（其余合法）→ 拉取后 `db.products.get(id)` 存在且 `category` 仍为 `'礼花弹'`，并写入一条 `yh-sync-warn` 诊断（对应 M-3） |
| 4 | `导入合并不得覆盖本机 operatorSelf`（`tests/merge.test.ts`） | 本地 `settings` 有 `operatorSelf='001'`，`importMerge` 的备份携带 `operatorSelf='999'` → 合并后本地仍为 `'001'`，且 `MergeResult.settingsImported` 不含该项（对应 M-2） |
| 5 | `重放轮同样跳过 pending 行，且不重复入队`（`tests/sync-inbound.test.ts`） | 本地 `db.orders` 有记录 + `db.outbox` 有 `order:o1`；远端同 id 更新版本 → 触发「每日重放」（清空 `yh-sync-last-replay`）→ 本地 `totalFen` 不变、`pendingCount()` 仍为 1、`db.conflicts.count() === 0`（锁定「重放不清本地、不记冲突、不回推」三条不变量） |

### 需运行验证（无法静态定论）

1. **H-1 阈值实测**：用假 Supabase 喂 9 999 / 10 000 / 10 001 行，确认 `capped` 边界与后续每轮请求序列。
2. **M-3/M-4 真实数据分布**：现有云端 `yh_records` 里是否存在 `category`/`payMethod` 值域外的历史行、以及「order 墓碑 + 更晚 line 行」的组合；若有，说明问题已发生。
3. **`conflicts` 现有规模**：`db.conflicts.count()` 与单行体积（每行两份完整 JSON）用于评估既有 L-6 是否已接近配额。