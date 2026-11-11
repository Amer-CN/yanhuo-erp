# 后端 / 数据层审查报告（2026-11-10）

## 审查范围

该项目没有传统服务端，"后端"= **Supabase（PostgREST + RLS）+ 前端数据层**。本次审查覆盖：

- `src/db/` 下的 types / db / repo / calc / merge / outbox / sync / syncDefaults（附带 `util.ts`、`syncResolve.ts`、`sessionLogic.ts`、`backup.ts` 作为调用链证据）。
- `supabase/schema.sql`：建表、主键、索引、RLS 策略、`updated_at` 维护方式。
- 同步相关配置：`docs/03-云同步设置.md` 与内置同步码（`src/db/syncDefaults.ts`）、`localStorage` 键名约定。

审查维度优先级：数据一致性与并发 → 事务与失败恢复 → 金额与数量计算 → 安全 → 可维护性。

性质：**只读审查**，未修改任何源码。

## 去重声明

- 已读 `docs/代码异味基线-20261110.md`：**「已消除」29 条、「已关闭」2 条（D2/D4）不再报告**，本报告不含其中任何一条。
- `C-001`（同步码是公开常量）按第十四节产品定位**已关闭，本报告不重复定性**，仅在安全小节记录核实结论。
- 仍然有效且**未修**的历史条目按基线要求继续计入：`M-001`（每次写入触发全表 `loadAll()`）、`M-008`（改单产生 2N 条发件箱记录）。`M-006` 属 UI 渲染，不在本次范围。
- `H-002 / H-003 / H-004 / H-005` 已在第十三、十四节修复并写入基线，本报告不复述、不重复建议。
- 所有结论均来自源码比对（含 `supabase/schema.sql`、`docs/03-云同步设置.md`），未做推测；未发现问题的维度在第二节明确写「未发现」。

---

# 一、发现列表

## High

### H-1 拉取水位用「推送方手机时钟」写入的 `updated_at`，时钟偏快的一端会永久漏拉另一端的记录（无自愈、无告警）

| 项 | 内容 |
|---|---|
| 级别 | **High** |
| 位置 | `src/db/sync.ts:362`（`updated_at: Date.now()`）、`src/db/sync.ts:654-675`（`buildPullParams`）、`src/db/sync.ts:762-781`（`pull`）、`supabase/schema.sql:10` |
| 问题 | 云端 `updated_at` 由**推送端** `Date.now()` 生成；拉取条件是 `updated_at > 本地水位`，而水位同样来自这些客户端时间戳——**包括本机自己推上去的行**（`pull` 只按 `ledger` 过滤，不排除 `device_id = 本机`）。于是"本机最后一次推送的时钟值"就成了另一台设备记录能否被看到的门槛。 |
| 后果 | 设 B 的时钟比 A 快 Δ。B 推送后水位 ≈ B 的"未来时间"；A 在 Δ 窗口内推送的行 `updated_at` 低于该水位，**永远不会被 B 拉到**（行的时间戳是固定的，水位只会继续上涨）。Δ=2s 时每次同步可能静默丢 1 单；Δ 为小时/天（手改系统时间、RTC 无电、时区误设）时两端账本**长期完全不一致**，而 `syncNow` 返回成功、设置页照常显示"已连接"，`yh-sync-warn` 也不会写。唯一的自愈路径是"清空标记"触发的全量重放，正常使用中不会发生。 |
| 修复建议 | ① 首选：`updated_at` 改由服务端生成（列 `default` / `BEFORE INSERT OR UPDATE` 触发器 `extract(epoch from now())*1000`，客户端不写该列），水位自然单调且跨设备一致；② 过渡方案（不改库）：拉取时用**重叠窗口**，每次把起点回退 `OVERLAP_MS`（如 5 分钟）重放，重复应用已被 `applyRemoteBatch` 幂等吸收；③ 兜底：每 N 次同步或每日首次启动做一次 `cursor = 0` 全量重放；④ 面板上增加"远端行数 vs 本地行数"偏差提示，让不一致可被发现。 |

---

## Medium

### M-1 「业务写入」与「outbox 入队」不在同一事务：入队失败会造成"账本有记录、永不发送"，且界面会报保存失败导致用户重录

| 项 | 内容 |
|---|---|
| 级别 | **Medium** |
| 位置 | `src/db/repo.ts:438-445`（`saveRecord`）；同样模式见 `:471-480`（`updateRecord`）、`:493-500`（`deleteRecord`）、`:523-532`（`undoPatchedRecord`）、`:554-555`（`closeSession`）、`:612-621`（`addPatchedRecord`）、`:171-172`（`createBatch`）、`:205-206`（`deleteBatch`）、`:95-96`（`createProduct`）、`:835-836`（`createAdjustment`）、`:30-33`（`setSetting`）、`:265-266`（`ensureOpenSession`） |
| 问题 | 统一写法是 `await db.transaction('rw', ...)` 落账，**事务结束之后**再 `await enqueueMany(...)` / `enqueue(...)`。两段各自独立事务，中间不是原子的。 |
| 后果 | ① 若 `db.outbox.put/bulkPut` 抛错（配额、库版本变更、标签页被系统回收），记录已入库但**永远不会被推送**，而抛出的异常会让 UI 提示"保存失败"→ 摊主重录 → **同一单重复记账**；② 进程在两次 await 之间被杀，静默留下永不发送的记录。全仓没有任何"补扫"机制（`markAllDirty()` 只在手动导入/撤销合并后被 `SettingsPage` 调用），所以这类记录只能靠人工发现。 |
| 修复建议 | 把 outbox 写入并入业务事务：`db.transaction('rw', [db.orders, db.lines, db.outbox], ...)`（Dexie 支持跨表同事务，`syncWanted()` 放到事务外）；或至少提供启动期对账器：扫描"本地存在、outbox 无条目、且 `updatedAt > localStorage['yh-sync-last-sync']`"的记录补入队，复用 `enqueueAllLocal()` 的批量路径。注意别破坏既有隐式契约（`clearAllData` 中 `outbox.clear()` 必须最后执行，见基线第十二节踩坑记录）。 |

### M-2 判定"本地较新"时只保留本地、**从不回推云端**，云端可能长期停留在旧版本

| 项 | 内容 |
|---|---|
| 级别 | **Medium** |
| 位置 | `src/db/sync.ts:513-523`（`keep-local` / `conflict` 分支均只 `continue`）、`src/db/syncResolve.ts:56-75` |
| 问题 | `planRemoteChanges` 在 `keep-local`（远端业务时间更旧）与 `conflict`（时间相同但内容不同）两条路径上都**直接跳过**：既不改本地，也不把本地版本重新入队。而云端那一行已被对方用更旧的版本覆盖（upsert by id，最后推送者赢）。 |
| 后果 | 典型链路：B 手机时钟慢 5 分钟 → B 改了单 X（`updatedAt` 11:55）后推送 → 云端 X = 11:55 版；A 拉到后判 `keep-local`（A 本地 12:00 版）→ **云端永久停留在 B 的旧版本**。A 本机看似正常，但一旦 A 换机/重装并从云端恢复，就拿到被回退的数据：已作废的单复活、补记丢失、`summary` 金额回退。手动导入合并路径同病（见 M-3）。 |
| 修复建议 | `keep-local` / `conflict` 时把该记录重新入队（`enqueue(kind, id)`），让云端向本地收敛；为避免两台设备互推造成循环，可用"仅当本地 `businessTime` 严格更大时才回推"作为门槛，或给回推加 `queuedAt` 节流（如同一记录 30s 内最多回推一次）。 |

### M-3 手动导入合并对订单只做「id 不存在才写入」，另一端的作废/补记/改单在合并中静默丢失

| 项 | 内容 |
|---|---|
| 级别 | **Medium** |
| 位置 | `src/db/merge.ts:129-132`（`addOnly(db.orders, …)`）、`src/db/merge.ts:80-88`（`addOnly` 实现） |
| 问题 | `batches / orders / lines / adjustments` 全部走 `addOnly`：**只看 id 是否存在，完全不看 `updatedAt`/`voided`**。而 `SalesOrder` 是可变的（`voidOrder` / `restoreOrder` / `updateRecord` / `addPatchedRecord` 都会原地改），云同步路径专门用 `record_updated_at` 处理这类变更，两条路径语义不一致。 |
| 后果 | A 端作废一张单并导出备份，B 端导入 → 该单在 B 端**仍是有效单**；B 端报表金额偏高，且紧接着的 `afterMerge()` 会把 B 的旧版本全量重推到云端，反而覆盖云端的正确版本（与 M-2 叠加）。用户看到的提示是"合并完成"，无任何异常信号。 |
| 修复建议 | 订单与场次同口径处理：同 id 时按 `updatedAt` 取新（`voided` 变化优先），或直接复用 `resolveRemote(kind, cur, incoming, businessTime(incoming))` 做决策；至少对 `voided` 差异无条件取"已作废"，避免合并后被"复活"。 |

### M-4 库存/成本两套口径：调整（盘亏/盘盈/退货）只进总量，不进 FIFO，同一屏数字对不上

| 项 | 内容 |
|---|---|
| 级别 | **Medium** |
| 位置 | `src/db/calc.ts:15-28`（`inventoryMap` 计入 `adjustments`）vs `src/db/calc.ts:87-154`（`fifoAllocate` 完全不看 `adjustments`）、`src/db/calc.ts:339-343`（`batchStock`）、`src/ui/pages/StockPage.tsx:38-52`（`totalQty` 用 `inv`，`totalValue` 用 `fifo.batchRemaining`） |
| 问题 | `inventoryMap = Σ批次 − Σ有效销量 + Σ调整`；FIFO 只按 `Σ批次 − Σ销量` 扣批。两者在存在 `adjustments` 时必然分歧，但 UI 把两者放进同一张卡片和同一个 Sheet 展示。 |
| 后果 | 记一笔"盘亏 5 件"后：列表与"当前库存"变成 95，**同一 Sheet 的"批次明细"剩余之和仍是 100**，"库存成本"也不变（成本按 `fifo.batchRemaining` 算，仍含已盘亏的货）；`expiryWarnings`（`calc.ts:311-331`）继续对已盘亏的批次报警。摊主盘点时看到的两个数字互相矛盾，成本口径虚高。 |
| 修复建议 | 二选一并统一：① 让 FIFO 也消费调整（把负向 `adjustment` 作为一条"消耗"按 `createdAt` 排序插入扣批序列，正向作为新批次投入），使 `batchRemaining` 成为唯一权威口径；② 或让库存页所有展示（总量/成本/批次明细）统一走 `inventoryMap` + 单独的"调整差异"行，并在批次明细旁注明"含 5 件盘亏未分摊到批次"。无论哪种，`expiryWarnings` 必须与所选用口径一致。 |

### M-5 `planRemoteChanges` 的 `deleted` 分支缺少 `SKIP_SETTINGS` 白名单（与 `put` 分支不对称），远端墓碑可以删掉本机 `deviceId`

| 项 | 内容 |
|---|---|
| 级别 | **Medium** |
| 位置 | `src/db/sync.ts:499-503`（`if (row.deleted) { … deleteRow(row.kind, row.record_id); continue; }`）vs `src/db/sync.ts:534-541`（put 路径有 `if (SKIP_SETTINGS.has(row.record_id)) break;`） |
| 问题 | 写入路径严格跳过 `deviceId / deviceName / sync-unknown-kinds`，删除路径**完全不判断**：任何 `kind='setting'` 且 `deleted=true` 的远端行都会执行 `db.settings.bulkDelete([...])`。当前仓库没有任何代码会 `enqueue('setting', key, 'delete')`，所以**暂时不可达**；但只要远端出现这样一行（旧版本 bug、控制台误操作，或按 M-6 所述持码者写入），就会命中。 |
| 后果 | `deviceId` 被删除后 `ensureDeviceId()` 会生成新 UUID；`getOpenSession()`（`repo.ts:243-248`）与 `App.tsx:72-77` 都按 `deviceId` 过滤 → **本机正在进行的场次立刻"找不到"**，被迫新开场次，`getLastSession` 也看不到原场次，结账链路断裂，历史场次归属错乱。`operatorA/B` 被删则回落到默认的"我 / 老婆"。 |
| 修复建议 | 在 `deleted` 分支加同样的守卫：`if (row.kind === 'setting' && SKIP_SETTINGS.has(row.record_id)) continue;`；更彻底的做法是"设置永不同步删除"（对 `setting` 直接忽略 `deleted=true`，只接受 upsert），并在 SQL 侧无对应约束时用单测锁死（`tests/sync-unknown-kind.test.ts` 已是同类测试的落点）。 |

### M-6 拉取侧对远端 `data` 不做任何结构与类型校验就 `bulkPut`，畸形/越界载荷会直接进入业务表并永久留在本机

| 项 | 内容 |
|---|---|
| 级别 | **Medium** |
| 位置 | `src/db/sync.ts:542-548`（default 分支 `putRow(row.kind, row.record_id, { ...(row.data as Record<string, unknown>), id: row.record_id })`）、`supabase/schema.sql:4-17`（`data jsonb` 无约束、无 `check`） |
| 问题 | 服务端只保证 `data` 是合法 JSON，不保证字段存在、类型正确、数值有限。客户端把它整体展开后 `bulkPut` 进 `orders/lines/batches`，**没有任何字段级校验**（对比写入侧 `buildLines` 有 `INVALID_QTY / INVALID_AMOUNT` 等完整校验）。`row.data` 若是 `null`/字符串/数组，展开结果同样会写进表。 |
| 后果 | 一条 `qtyBase: -1e9` 或 `amountFen: "abc"` 的远端行会让 `sessionReport` 的 `revenueFen` 变 `NaN`，整场报表金额与毛利全变 `NaN`；`totalFen` 与明细之和不一致时没有任何自检。这类脏行一旦落库就**不会自愈**（`keep-local` 语义使它不会被覆盖回正确值），只能清库或手动控制台修。结合 `schema.sql` 的 `grant insert to anon` + 同步码随 bundle 公开，任何持码者都能注入（这不是重复 `C-001` 的"可读账本"定性，而是"入站数据无校验"这一层缺失）。 |
| 修复建议 | 增加 `parseRemoteRecord(kind, data)` 校验层：按 kind 校验必填字段与类型（`typeof === 'number' && Number.isFinite`），失败则跳过该行并写 `yh-sync-warn` 诊断（保留行 id，最多 20 条，复用 `mergeUnknownKinds` 的写法），绝不 `bulkPut`；同时给 `yh_records.data` 加最小约束（如 `check (jsonb_typeof(data) = 'object')`）。 |

---

## Low

### L-1 索引 `(ledger, record_updated_at)` 没有任何查询使用，只是写放大

| 项 | 内容 |
|---|---|
| 级别 | **Low** |
| 位置 | `supabase/schema.sql:44-45` |
| 问题 | 全仓检索 `record_updated_at`：仅出现在 `PULL_COLUMNS`（`sync.ts:623`）的 select 列表里，**从未作为过滤/排序条件**；`pull` 排序用 `updated_at,id`，索引 `(ledger, updated_at, id)` 已覆盖。该索引每次 INSERT/UPDATE 都要维护。 |
| 后果 | 无查询收益，纯写入成本；它也是 `schema.sql` 的"覆盖证据"注释里唯一一个没被证明用途的索引。数据量小，实际影响是"每次推送多维护一棵 B 树 + 误导后来者以为存在按业务时间的查询路径"。 |
| 修复建议 | `drop index if exists public.yh_records_ledger_record_updated;`（幂等，附回滚语句），或明确保留用于将来"按业务时间做冲突扫描"并在注释里写清用途；若只是为将来预留，建议删掉，需要时再加。 |

### L-2 远端行只增不清理 + 全量重放有 20 页硬上限：账本越大，"清空后重放"越可能一次拉不完且无提示

| 项 | 内容 |
|---|---|
| 级别 | **Low** |
| 位置 | `src/db/sync.ts:65`（`MAX_PAGES = 20`）、`:67`（`PAGE_SIZE = 500`）、`:762-781`（循环到上限即返回，无 `hasMore`）；行数增长来源见 `src/db/sync.ts:816-843`（软删只置 `deleted`）与 `repo.ts:471-475`（改单整组重建明细，旧行留墓碑） |
| 问题 | 一个赛季 2000 单 × 3 明细 ≈ 8000 业务行，加上每次改单产生的 N 条旧明细墓碑（`M-008`），很容易超过 **20 × 500 = 10000 行/次**。`pull` 到上限就 `return pulled`，`syncNow` 仍返回成功。 |
| 后果 | 正常增量同步不受影响（游标会逐轮推进）；但"清空标记"触发的**全量重放**（`resolvePullStart` 归 0）在超限时只重放了一部分，其余要等后续几轮才补齐——期间两端仍看到部分旧数据，无任何提示，容易被误判成"清空失败"。 |
| 修复建议 | `pull` 返回 `{ pulled, hasMore }` 并在 `SyncPanel` 显示"还有 N 轮未拉完"；把重放路径的页上限单独放宽（如 `MAX_PAGES_REPLAY = 200`）；长远考虑 tombstone 归档（如 `deleted` 且超过 90 天的行物理删除，走 `service_role` 定时任务），否则"云端作为备份"的恢复时间会随赛季线性变长。 |

### L-3 业务时间只有本机时钟一个来源，时间回退后本地新编辑会被远端旧记录判为"更旧"而覆盖

| 项 | 内容 |
|---|---|
| 级别 | **Low** |
| 位置 | `src/db/util.ts:16-18`（`nowIso`）、`src/db/repo.ts` 各写入点、`src/db/syncResolve.ts:56-62` |
| 问题 | 所有 `updatedAt / createdAt / closedAt` 都取 `new Date().toISOString()`，从不用服务端时间，也不做单调保证。`resolveRemote` 用 `remoteTime > localTime → take-remote` 做 LWW。 |
| 后果 | 用户把手机时间改回正确值（或自动校时回拨）后，新做的编辑 `updatedAt` 比上次推送的旧值更小 → 拉取时判 `take-remote`，本地真实的新编辑被**旧版本覆盖**，且不留冲突痕（因为时间可比较，不走 `conflict` 分支）。这属于 LWW 的反向覆盖，与 H-1 同源但危害路径不同（H-1 是漏拉，本条是覆盖）。 |
| 修复建议 | 写入时用"单调时钟"：`updatedAt = max(nowIso(), 该记录当前 updatedAt + 1ms)`；配合 H-1 的服务端时间方案，把"用于排序的时间"和"用于展示的时间"分开。 |

### L-4 快照的「读—算—写」跨事务，落库时可能用旧快照覆盖同步刚拉来的新快照

| 项 | 内容 |
|---|---|
| 级别 | **Low** |
| 位置 | `src/db/repo.ts:601-616`（`addPatchedRecord`）、`:543-556`（`closeSession`）、`:512-527`（`undoPatchedRecord`）、`:630-637`（`refreshSessionSummary`） |
| 问题 | 都是"`loadLedger()` 读全表 → 内存算 `summary` → 开事务只写结果"。读与写之间若发生一次 `applyRemoteBatch`（另一台设备补记/作废了同一场次的单），本次写入会用**基于旧数据的 `summary`** 覆盖拉取到的正确快照，并且 `updatedAt` 更新 → `mergeSessionPair` 让这份旧快照在后续合并中获胜。 |
| 后果 | 已结账场次的 `summary` 少算一单，报表（读 `summary`）长期偏低，只有等到下次作废/补记/进货触发重算才会纠正。窗口很短（毫秒级），发生概率低，但一旦发生是**静默且不自愈**的金额错误。 |
| 修复建议 | 把 `loadLedger()` 与写回放进同一个 `db.transaction('rw', db.orders, db.lines, db.batches, db.sessions)`；Dexie 事务内读到的就是一致快照，代价可忽略（这几处本来就是低频操作）。 |

### L-5 「测试连接」不带 `ledger` 过滤，同步码写错也会显示连接成功

| 项 | 内容 |
|---|---|
| 级别 | **Low** |
| 位置 | `src/db/sync.ts:802-804`（`testSyncConfig` → `yh_records?select=id&limit=1`） |
| 问题 | RLS 是"按 header 里的 `x-ledger-key` 过滤行"，不是"拒绝访问"——`select` 在同步码错误时返回**空数组而不是错误**，`res.ok` 为真。 |
| 后果 | 用户输错同步码 → 点"测试连接"通过 → 之后每次推送才 403（`insert` 的 `with check` 会拒绝），错误信息要等到走完 4 轮退避才浮现；排查方向被误导为"网络问题"。 |
| 修复建议 | 主动断言：先按 `ledger=eq.{key}&limit=1` 查一次；另发一条"探针 upsert"（如 `id = __probe__:<ledger>` 的标记行，与清空标记同风格）验证写权限，写失败明确提示"同步码不对或账本不存在"；探针行在 `pull` 侧按前缀过滤。 |

### L-6 冲突留痕只写不消费：只有计数，无明细、无消解入口、无过期清理

| 项 | 内容 |
|---|---|
| 级别 | **Low** |
| 位置 | `src/db/sync.ts:514-523`（写 `conflicts`）、`:567`（`bulkAdd`）、`src/ui/pages/SettingsPage.tsx:756`（仅 `db.conflicts.count()`） |
| 问题 | 判为 `conflict` 的行被写入 `db.conflicts`（含 local/remote 双份 JSON）后，**没有新增任何读取/展示/删除路径**，只有设置页显示一个数字；`clearAllData` 之外没有任何清理逻辑（基线 L-002 已修的是"清空时一起清"）。 |
| 后果 | 一旦出现真冲突，用户只看到一个无法点击的数字，既看不到是哪条记录，也没有"采用哪边"的动作，冲突实际上等于"永久静默保留本地 + 云端停留旧值"（与 M-2 叠加）。表也会随冲突累积膨胀（每条含两份完整 JSON）。 |
| 修复建议 | 要么补齐最小闭环（列表 + "用本地/用远端"两个按钮，采用远端时重新拉该行），要么明确降级为诊断：只保留最近 50 条 + 90 天过期清理，并在设置页给出文案指引（"这 N 条已按本机为准"），不要让数字悬空。 |

---

# 二、核实后确认无问题的点（供交叉验证）

| 维度 | 核实结论 |
|---|---|
| RLS 实际强度 | `schema.sql:62-85` 三条策略均以 `ledger = current_setting('request.headers')::json ->> 'x-ledger-key'` 为唯一谓词，`update` 同时有 `using` + `with check`（防止把行挪到别的 ledger）；headers 缺失时 `coalesce(...,'')` **失败关闭**（匹配不到任何行）；`revoke delete from anon` 生效，清空必须走 PATCH 软删。**不存在"任意 anon 读写全部账本"的漏洞**；剩余风险仅"持同步码者可读写本账本"（= 已关闭的 C-001 定性），以及 M-6 的载荷校验缺失。 |
| SQL 注入 / 越权入口 | `schema.sql` 无动态 SQL；策略与权限均为静态 DDL，无可注入入口。`on_conflict=id` + `merge-duplicates` 只能写本 ledger 的行（`with check` 兜住）。 |
| 索引与同步拉取 | `yh_records_ledger_updated_id(ledger, updated_at, id)` 与 `pull` 的 `order=updated_at.asc,id.asc` + `or=(...)` 行比较完全对齐；`readClearMark` 走主键；`push` 走 `on_conflict=id` 主键。**未发现全表扫描路径**（唯一冗余索引见 L-1）。 |
| 金额与数量精度 | `types.ts:1` 的整数分/整数基本单位在 `calc.ts` 全链路成立：`productAvgCostFen` 用 `Math.round(总成本/总量)`，`fifoAllocate` 的 `take * unitCostFen` 全整数，`buildLines` 对 `amountFen/unitCostFen/qtyBase` 全部 `Math.round`，`strToFen` 拒绝多于 2 位小数。**不存在浮点累积误差**（唯一非整数运算是"均价"与"展示单价"，且都即时取整）。库存可为负是设计约定（`calc.ts:14` 注释），非缺陷。 |
| outbox 幂等与顺序 | 主键 `${kind}:${recordId}` + `put` 天然去重，同一记录多次改动合并为一条，`queuedAt` 保持插入序；重发只会产生 `upsert by id`，**不会产生重复记录**；`deleted` 标记来自 op 或"本地已不存在"，删除后重发也幂等。复合游标 `(updated_at, id)` 的 `nextCursor` 已含"同毫秒 id 回退"防御（基线 第十三节复核补丁），**同毫秒多条不再漏**。 |
| 删除语义 | 本地是硬删 + 远端 `deleted=true` 墓碑（`schema.sql:16`），旧设备 pull 到墓碑即删，**不会把已删记录拉回来**（同一 row id 的 upsert 会把 `deleted` 改回 false，只有"重新创建"这一种情况会复活，属预期）。`deleteBatch` 的"已卖出不可删"门槛已把"删批次改写历史成本"堵住（基线 H-004）。 |
| 本地优先红线 | `sync.ts` 全部网络调用都在 `useSync` 的 `busy` 锁与 15s 超时内，`pull` 失败不推进游标；`readClearMark` 任何异常返回 0；**没有一处写入依赖网络**，离线只影响同步、不影响开单。重试退避 1s→2s→4s…→60s 有间隔上限（次数不封顶，属离线容忍的合理取舍）。 |
| 密钥与配置 | 同步配置只存 `localStorage`（`LS` 表），`SKIP_SETTINGS` 把 `deviceId/deviceName/sync-unknown-kinds` 排除在云端之外；`docs/03` 第十二节的键清单与 `sync.ts:29-42` 的 `LS` **逐项一致**（含 `yh-sync-last-pull-id`、`yh-sync-cleared-at`），未发现文档漂移。 |

---

# 三、后端/同步层整体评价

数据层的水位明显高于"自用地摊工具"这个定位：整数分建模、FIFO 重放、`(updated_at,id)` 复合游标、软删除 + 清空标记行、缺列双向降级、`bestEffortSnapshot` 这类"主数据已落、补偿失败不误导用户重录"的处理，都是踩过坑之后才写得出来的东西，**结构上已经可以长期用**。

真正的短板集中在两处：一是**时间基准**——`updated_at` 和业务 `updatedAt` 全部来自手机本地时钟，H-1 让"两台手机互相同步"这一核心承诺建立在一个没有校准的假设上，且失败是完全静默的；二是**收敛方向单一**——`keep-local`、`conflict`、手动合并三条路径都只"保本地"，没有任何一条把本地版本回推云端，于是云端会慢慢偏离真实账本，而云端恰恰是"换手机/重装"时的唯一来源。

M-1（入队不在事务内）与 M-4（调整不进 FIFO）是两类典型的"看着对、边界上不对"：前者把可靠性寄托在两次 await 之间不出事，后者让库存页同一屏的两组数字互相矛盾。安全性上不必再纠结 C-001——RLS 的闭包是严谨的，清空也已不可物理抹除；真正该补的是**入站校验**（M-6）和那条不对称的 `deleted` 白名单（M-5），它们才是"持码者把账本搞坏"的现实入口。

如果只做三件事：① 把 `updated_at` 交给服务端（或先加 5 分钟重叠窗口），② 给 `keep-local` 加回推，③ 把 outbox 写进业务事务。这三条都不改架构、都不碰本地优先红线，但能消掉本报告里全部 High 和两条最贵的 Medium。