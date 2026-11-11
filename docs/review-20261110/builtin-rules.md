# 内置规则审查报告（2026-11-10）

本次审查对象：工作区未暂存 diff（`unstaged.diff`，38693 字节）。

## Review Findings

内置规则命中 1 条（Minor）；另外发现 6 条与本仓库「本地优先 + 快照一致性」约定相关的正确性/健壮性问题，按严重度一并列出，供汇总时取舍。

---

### [Minor] RuleId: G.ASY.01
**File:** src/db/sync.ts
**Line:** 711
**Issue:** `catch` 分支里的 `return await request();` 属于不必要的 `return await`——它不在任何 `try` 内，没有需要捕获的错误，只多一次微任务调度。同函数 `try` 内的 `return await request()`（第 705 行）是必要写法，保留即可。
**Fix:** 改为 `return request();`；同时补 `// 此处不再重试，直接抛给调用方` 的注释说明降级只做一次。

---

### [Medium] 部分成功被报成失败（与本次改动的设计原则自相矛盾）
**File:** src/db/sync.ts
**Line:** 816-843（`clearCloud`）
**Issue:** 先 PATCH 打 tombstone（真正的清空），再 POST 标记行。若标记行写入失败（RLS 变更、网络抖动、旧库 `on_conflict` 行为差异），`clearCloud` 会 reject，UI 报「清空失败」——但账本其实已经被清空。用户按提示重试虽然幂等，但会更困惑；而本次改动在 `repo.ts` 里恰好为了同样的理由（`bestEffortSnapshot`）明确写了「已生效的写入不能报成失败」。
**Fix:** 把标记行写入包在 best-effort 里，失败只走降级提示（复用同文件已有的 `warnDegraded`），例如：
```ts
try {
  await rest(cfg, 'yh_records?on_conflict=id', { ... });
} catch (e) {
  warnDegraded('清空已生效，但清空标记写入失败：对方设备可能需手动重放一次');
  // 不抛出：PATCH 已生效，重试无意义且会误导用户
}
```

---

### [Medium] FIFO 排序键在 repo 侧重复实现，漂移会静默漏重算
**File:** src/db/repo.ts
**Line:** 144-147（`batchSortKey`）／对照 src/db/calc.ts:103-107
**Issue:** `batchSortKey` 复刻了 `fifoAllocate` 内部的比对串。目前两者字面一致（含 `receivedAt` 缺省时 `"undefined"` 前缀这种反直觉行为也一致），但这是**隐式契约**：将来若在 `calc.ts` 把排序改成 `receivedAt || createdAt` 或改分隔符，`createBatch` 的 `isFifoLast` 会静默判错 → 该重算的已结账快照被跳过 → 历史成本与报表数字长期偏差，且无任何报错、无测试能发现（测试断言的是当前口径）。
**Fix:** 从 `calc.ts` 导出该比对器并单点维护：
```ts
// calc.ts
export function batchOrderKey(b: Batch): string { return `${b.receivedAt}|${b.createdAt}|${b.id}`; }
// fifoAllocate 内部与 repo.ts 都 import 它
```

### [Medium] `bestEffortSnapshot` 的注释承诺「留一条本机诊断」，实际只有 console.warn
**File:** src/db/repo.ts
**Line:** 217-223
**Issue:** 注释写「失败留一条本机诊断，等下次结账 / 重算时自然对齐」，但实现只有 `console.warn`。摊位手机不会有人看控制台，所以一旦重算持续失败（配额满、事务中断），已结账快照会一直停在旧成本，而界面上没有任何信号——净效果是「报表数字悄悄错了」。同文件/同 PR 的 `warnDegraded` 已经把降级信息落到 localStorage，口径不一致。
**Fix:** 失败时写一条可见诊断（复用 `yh-sync-warn` 风格的键或 `db.settings` 里的诊断项），让同步面板/设置页能提示「报表待重算」；同时保留 console 输出便于排障。

---

### [Medium] `resolvePullStart` 用相等比较，远端标记变小时会白跑一次全量重放
**File:** src/db/sync.ts
**Line:** 741-754
**Issue:** 判定是 `mark === clearedMark()` 取反，而不是 `mark > clearedMark()`。清空标记值取的是**执行清空那台设备的 `Date.now()`**；若那台设备时钟偏慢，同一次「后发生的清空」可能产生更小的值，于是 `mark !== clearedMark` 成立 → 再次重置游标到 0、重放全库，并且把本地 `clearedMark` 调低。功能上能收敛，但会多一轮全量拉取（弱网下就是明显的等待）。
**Fix:** 只在 `mark > clearedMark()` 时重置；`mark <= clearedMark()` 一律按 `local` 游标继续，避免值回退引起的重放。

### [Medium] 每次增量 pull 多一次标记探针请求，同步请求数翻倍
**File:** src/db/sync.ts
**Line:** 744-747（`readClearMark` 调用点）
**Issue:** 只要本地水位 > 0，每轮同步都多打一次 `yh_records?id=eq.__ledger_cleared__:...`。本项目 `syncNow` 是按退避/定时反复调用的，请求数与流量直接翻倍，与 `PULL_COLUMNS` 注释里「只取应用用得到的字段」的省流导向相悖。
**Fix:** 二选一：① 记录上次探针时间（例如 ≥ 5 分钟才探一次，清空不是高频操作）；② 用 `order=updated_at.desc&kind=eq.ledger&limit=1` 的探针，或直接把标记行并入 pull 的 select 条件，减少往返。

---

### [Minor] `createBatch` 不校验数量/单价，而明细侧有 `INVALID_QTY`
**File:** src/db/repo.ts
**Line:** 163-164
**Issue:** `qtyBase: Math.floor(input.qtyBase)`、`unitCostFen: Math.max(0, Math.round(...))` 没有 `Number.isFinite` / `> 0` 校验（`buildLines` 对明细做了 `INVALID_QTY`）。`NaN`/负数批次会污染 `productAvgCostFen` 的加权与 `stockedAfter` 累加，进而让本次新增的 `soldQty <= stockedAfter` 判定恒为 false、把 `NaN` 成本写进已结账快照。目前进货页有 `qtyBase <= 0` 的 UI 校验兜住，但 repo 是同步/合并也会走的一层。
**Fix:** `createBatch` 开头加与 `buildLines` 对称的校验：`if (!Number.isFinite(q) || q <= 0) throw new RecordError('INVALID_QTY', '数量要大于 0')`。

### [Minor] 标记行 `kind='ledger'` 对旧客户端是未知 kind，会挤占诊断名额
**File:** src/db/sync.ts
**Line:** 279-281、827-841
**Issue:** 新版客户端会在 pull 侧整行过滤；但**未升级的旧客户端**会把 `ledger:__ledger_cleared__:xxx` 记进 `sync-unknown-kinds`（上限 20、FIFO 淘汰），可能把真正需要排查的未知 kind id 挤掉，制造误导性诊断。而且标记行是永久存在、会随每次清空刷新的。
**Fix:** 在 `applyRemoteBatch` 的未知 kind 归类里也跳过 `isClearMarkerRow`（一行判断即可），或在 `mergeUnknownKinds` 里加过滤。

### [Minor] 新增的拉取降级/清空标记分支没有测试覆盖
**File:** tests（应为 tests/sync-cursor.test.ts 或新文件）／src/db/sync.ts:696-713、741-783
**Issue:** 本次改动风险最高的部分是 `fetchRemotePage` 的缺列降级重试、`resolvePullStart` 的游标重置、`pull` 的标记行过滤，但 diff 只给 `clearCloud` 加了测试（3 个用例），这三处新逻辑仍是零覆盖。仓库已有 `sync-cursor.test.ts` 的假 Supabase 基建，补齐成本很低；而按 `docs/代码异味基线-20261110.md` 的约定，这类「靠水位/降级自愈」的逻辑正是最需要回归锁的地方。
**Fix:** 补 3 个用例：① 首次 GET 返回 `42703 record_updated_at` → 第二次 GET 的 `select` 降级为 `PULL_COLUMNS_LEGACY` 且只重试一次；② 本地水位 > 0 且标记值变化 → 第一页请求不带游标条件、`yh-sync-cleared-at` 被写入；③ 页内含标记行 → 不写业务表、不计入 `pulled`、游标照常推进。

---

补充说明（不构成缺陷，已在代码中记录为已知代价）：本次把 `deleteBatch` 的占用判定收敛为「单商品口径」，我核对过 `calc.fifoAllocate` 的 `byProduct` / `queueIdx` / `productAvgCostFen` 确实全部按 productId 分组，单商品重放与全表重放对 `batchRemaining` 等价，该优化成立；`createBatch` / `deleteBatch` 的 `stockedDeltaQty` 符号（新增 `+qtyBase`、删除 `-qtyBase`，且都基于「变更已落库后」的批次集合计算 `stockedAfter`）也自洽。