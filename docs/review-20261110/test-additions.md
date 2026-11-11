# 测试补强执行报告（2026-11-10）

> 范围：`docs/review-20261110/testing.md` 的 High/Medium 主体落地（第一批），外加收尾批（M2 缺列降级、`fenToStr` 转正、复位钩子接线）。
> 可改范围：**仅** `tests/**` 与 `vitest.config.ts`；`src/**` 一个字没动（见第五节）。
> 断言口径以 `docs/review-20261110/db-fix-report.md` 记录的**新行为**为准（5 分钟重叠窗口在 `pullStartCursor()`、回推带防回声、`parseRemoteRecord` 校验层、墓碑删除白名单、outbox 事务化）。
> 收尾批依赖 DbFixer 已落地的两处实现改动：`fenToStr` 改为「先取整再判符号」、`sync.ts` 导出 `__resetSyncFlagsForTest()`。

---

## 一、门禁结果（真实输出）

### `pnpm exec tsc --noEmit`

```
（无任何输出）
=== exit=0 ===
```

**错误总数：0。**

### `pnpm test`

```
✓ tests/calc.test.ts              (15 tests)
✓ tests/session.test.ts           (12 tests)
✓ tests/clear-cloud.test.ts        (3 tests)
✓ tests/outbox.test.ts             (4 tests)
✓ tests/session-migrate.test.ts    (4 tests)
✓ tests/sync-unknown-kind.test.ts  (2 tests)
✓ tests/merge.test.ts              (7 tests)
✓ tests/backup.test.ts             (4 tests)
✓ tests/sync-cursor.test.ts       (19 tests)
✓ tests/sync-inbound.test.ts      (18 tests)   ← 新增文件
✓ tests/repo.test.ts              (24 tests)
✓ tests/sync-resolve.test.ts      (15 tests)

Test Files  12 passed (12)
     Tests  127 passed (127)
```

**通过 127 / 失败 0 / 跳过 0。** 基线 11 文件 / 90 用例 → 现 **12 文件 / 127 用例全绿**。
第二批（收尾）净增 6 条：`calc.test.ts` 的 skip 转正 1 条 + `sync-cursor.test.ts` 的缺列降级 5 条（详见第三、四节）。

### `pnpm test:cov`（含阈值）

```
ERROR 无，exit=0
```

当前 `src/db/sync.ts` **lines 82.63%**（per-file 阈值 75，缓冲 7.63pt）、全局 lines 89.53%。
阈值配置见第六节，已用「临时把 `lines` 抬到 99」实测门禁会红：
`ERROR: Coverage for lines (78.4%) does not meet "src/db/sync.ts" threshold (99%)`（该次为第一批时的读数）→ 说明 per-file 阈值真实生效，随后已改回 75。

---

## 二、变更文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `tests/sync-inbound.test.ts` | **新增** | 同步入站四路径 + 回推防回声 + `parseRemoteRecord` 表驱动，18 条 |
| `tests/sync-cursor.test.ts` | 改 | 假 Supabase 增加「清空标记探针 / 推送 / 可注入错误」路由；新增 10 条（游标与红线 5 + 缺列降级 5） |
| `tests/calc.test.ts` | 改 | `expiryWarnings` 正例 2 条、金额/取整边界 3 条；`fenToStr` 负数取整由 `it.skip` **转正**为强断言 |
| `tests/setup.ts` | 改 | **新增全局 `afterEach(() => __resetSyncFlagsForTest())`**，复位缺列降级标志与回推节流表 |
| `tests/repo.test.ts` | 改 | 拆分 `loadAll`/`clearAllData` 合并用例、删两条恒真断言、新增 3 条 |
| `tests/helpers.ts` | 改 | `resetDb()` 补 `db.conflicts.clear()` |
| `vitest.config.ts` | 改 | `include` 通配 `.tsx`；`src/db/sync.ts` per-file `lines ≥ 75` |

> `tests/clear-cloud.test.ts` 与 `tests/repo.test.ts` 的工作区改动里有一部分来自上一批 DB 修复批次（本次开工前 `git status` 已显示 M），不是本次产出。

---

## 三、用例清单（编号 → 用例名 → 断言要点）

### 组 1：同步入站四路径（`tests/sync-inbound.test.ts`，8 条）

| # | 用例名 | 断言要点（业务结果） |
|---|---|---|
| 1.1 | `pull 收到 deleted 的 order 时连带删除本地明细` | `db.orders.get('o1')===undefined`；`db.lines.where('orderId').equals('o1').count()===0`；`pendingCount()===0`（删除是云端事实，不得反向回推） |
| 1.2 | `墓碑删除不删设备级设置，业务设置照删` | `deviceId`/`deviceName` 墓碑后本地值仍在；`operatorA` 墓碑后 `undefined`（锁 `SKIP_SETTINGS` 守卫） |
| 1.3 | `两端同时间不同内容：写一条冲突留痕且本地值不变` | `db.conflicts.count()===1`；`kind/recordId` 正确、`at` 可被 `Date.parse`；`JSON.parse(local).totalFen===1000`、`JSON.parse(remote).totalFen===2000`；本地 `totalFen` 仍 1000；冲突同时登记 `outbox.get('order:o1')` |
| 1.4 | `本地有 pending 时 pull 不覆盖本地值` | 用「pull 往返期间再入队」复现真实竞态（push 已跑完、pull 途中又改一笔）；断言本地 `totalFen` 仍 1000 |
| 1.5 | `发件箱积压 301 条时，第一轮不覆盖本地、第二轮补推后能对齐远端` | 301 > `OUTBOX_BATCH(300)`：轮 1 `pendingCount()===1` 且本地 1000；轮 2 `pendingCount()===0` 且本地 **2000**（远端更新没被水位永久吃掉）；并断言轮 1/轮 2 的拉取请求都不带 `or`/`updated_at` 游标（=重叠窗口把起点夹到 0 重放） |
| 1.6 | `推送 500 时发件箱不清空，重试成功后清空` | `rejects.toThrow(/Supabase 500/)`；`pendingCount()` 1→1→0；`yh-sync-last-sync` 未写；本地订单未丢 |
| 1.7 | `远端是对方旧版本时重新入队回推，且本地值不变` | 本地较新（`record_updated_at` 更旧）→ `outbox.get('order:r1')` 存在，本地 `totalFen` 仍 1000 |
| 1.8 | `远端就是本地刚推上去的回声时不重复入队、也不写冲突` | 内容/时间与本地完全一致 → `pendingCount()===0`、`conflicts.count()===0`（防回声 + 节流双闸门） |

> 时间相关断言全部用**固定 ISO / 固定毫秒**，没有 `setTimeout`、没有真实时钟。

### 组 1 附带：校验层表驱动（同文件，10 条，对应组 3 的 #11）

| # | 用例名 | 断言要点 |
|---|---|---|
| 3.1–3.9 | `拒绝非法远端行：<场景>` ×9 | `null` / 数组 / 字符串 / 数字 / `totalFen:'abc'` / `qtyBase:NaN` / `qtyBase:0` / `payMethod:'Cash'` / 必填字段缺失 → `parseRemoteRecord()` 一律 `null` |
| 3.10 | `合法远端行原样接受` | 合法 order 返回对象与输入 `toEqual`；合法 line 非 `null` |

### 组 2：游标、降级与红线（`tests/sync-cursor.test.ts`，5 条）

| # | 用例名 | 断言要点 |
|---|---|---|
| 2.1 | `首轮起点回退 5 分钟；cursor=0 时原样返回` | `{ts:100000,id:'x'}→{ts:0,id:''}`；`{ts:0}→{ts:0}`；`{ts:10000000,id:'x'}→{ts:9700000,id:''}` |
| 2.2 | `重叠窗口只作用于请求起点，持久化水位仍按真实行尾推进` | 首请求 `updated_at=gte.9700000` 且无 `or`；同步后 `yh-sync-last-pull==='10000001'`、`-id==='order:a'`（**不是**回退值） |
| 2.3 | `离线时 syncNow 抛「当前离线」且不动水位与发件箱` | `navigator.onLine=false` → `rejects.toThrow('当前离线')`、`fetch` **零次调用**、`last-pull`/`last-sync` 均 `undefined`、`pendingCount()===1` |
| 2.4 | `恢复在线后同一批发件箱能正常推送` | `pushed===1`、`pendingCount()===0` |
| 2.5 | `yh-sync-disabled=1 时 getSyncConfig 返回 null（测试数据不写真实账本的闸门）` | 置 `disabled='1'` → `null`；移除后回落内置 `DEFAULT_SYNC` 三项 |

### 组 2 附加：schema 缺列降级重试（`tests/sync-cursor.test.ts`，5 条，对应 testing.md 的 M2）

| # | 用例名 | 断言要点 |
|---|---|---|
| 2.6 | `推送遇到 PGRST204 缺 record_updated_at 时去列重试一次，第二次请求不再带该列` | 推送 body 共 2 次：第 1 次 `toHaveProperty('record_updated_at')`、第 2 次 `not.toHaveProperty(...)`；`schema_version` 仍为 2（只摘缺的那列）；`pendingCount()===0`；同一轮 pull 已用 legacy 列清单 |
| 2.7 | `已降级后再次推送不再带 record_updated_at，也不再先撞一次 400` | 第二轮只有 **1 次**推送且 body 不含该列（锁 `buildPushPayload` 的 `if (!recordColumnMissing)` 短路） |
| 2.8 | `纯网络错误不做降级：只发一次推送并原样上抛` | `rejects.toThrow('Failed to fetch')`；`fetchMock` 总共只 1 次调用；`pendingCount()===1`；`getUrls` 为 0（pull 未跑）、`yh-sync-last-pull` 未写 |
| 2.9 | `拉取遇到 42703 时降级为 legacy 列清单且只重试一次` | 拉取 2 次：第 1 次 `select` 含 `record_updated_at`、第 2 次等于 legacy 清单；`pulled===1`、远端订单真的落库；无第 3 次请求 |
| 2.10 | `降级后再拉一轮直接用 legacy 列清单，不再先撞 400` | 置位后下一轮只有 1 次请求且 `select` 即 legacy（锁 `fetchRemotePage` 的 `if (recordColumnMissing)` 短路） |

> 该 5 条依赖 `tests/setup.ts` 的全局 `afterEach(() => __resetSyncFlagsForTest())`：**已反向验证**——临时把该行注掉后本组立刻 3 红（`已降级后…`/`拉取遇到 42703…`/`降级后再拉一轮…`），恢复后全绿，证明复位钩子是真的在起作用而不是摆设。

### 组 3：`clearAllData` / `resetDb` / 恒真断言清理（`tests/repo.test.ts`，3 条新增 + 1 处拆分）

| # | 用例名 | 断言要点 |
|---|---|---|
| 3a | `loadAll 返回 7 张业务表，且每张表条数与 count() 一致` | 7 张表**逐表** `toHaveLength(await db.X.count())` —— 取代原 `expect(Array.isArray(...)).toBe(true)` 恒真断言；另钉住 products/orders 各 1 条、lines > 0 |
| 3b | `clearAllData 清空业务表、冲突留痕与发件箱，并重置迁移标记` | 先造 1 条 `db.conflicts` 行；清空后 products/orders/lines/**conflicts**/outbox 全 0，`seeded`/`sessionsMigrated` 为 `''`（同时锁死「outbox 必须最后清」的顺序） |
| 3c | `resetDb 后 conflicts 与 outbox 均为 0` | 脚手架自检：写入 conflicts+outbox 各 1 → `resetDb()` → 双 0（防止将来新增表又漏清） |
| 3d | `调整量按 Math.round 落库：负数半入朝 +∞（-2.5 → -2，不是 -3）` | `createAdjustment(-2.5).qtyBase===-2`、`+2.5→3`（业务层，不只断言 `Math.round`） |

原用例中与主题无关的 `expect(order.id).toBeTruthy()` 已删除；`Array.isArray` 两条恒真断言已删除。

### 组 4：计算边界（`tests/calc.test.ts`，6 条，其中 1 条由 skip 转正）

| # | 用例名 | 断言要点 |
|---|---|---|
| 4.1 | `窗口内的临期批次按 daysLeft 升序返回，已过期的排最前` | 固定 `today='2026-01-10'`；造 −2 / +5 / +31 / 无有效期四条 → 结果 id 顺序 `['b-expired','b-soon']`、`daysLeft` `[-2, 5]`、`productName`/`remaining` 正确（原「空集」用例保留） |
| 4.2 | `warnDays 边界：恰好落在预警上限当天的批次也算命中` | `expiryDate === today+30` → 命中且 `daysLeft===30`（锁 `>` / `>=` 口径） |
| 4.3 | `strToFen 处理负号、尾点、千分位，并拒绝三位小数` | `-3.05→-305`、`-0.5→-50`、`'1.'→100`、`'1,234.50'→123450`、`'￥ 12.50'→1250`、`0.001/1.005→null`、`999999999999.99→99999999999999` |
| 4.4 | `fenToStr 处理超过 1e9 的分值与小数取整` | `1e9→'10000000.00'`、`0.4→'0.00'`、`10.6→'0.11'` |
| 4.5 | `Math.round 是向 +∞ 取整而不是四舍五入：10.5→11、-2.5→-2` | 负数半入方向（配合 3d 在业务层再钉一次） |
| 4.6 | `fenToStr 先取整再判符号：非整数分不会出现 -0.00`（**原 `it.skip` 转正**） | `-0.4→'0.00'`、`0.4→'0.00'`、`-100→'-1.00'`、`-1→'-0.01'`、`1e9→'10000000.00'` |

---

## 四、`it.skip` 清单（0 条，唯一一条已转正）

| 原 # | 原文件:行 | 原用例名 | 现状 |
|---|---|---|---|
| 1 | `tests/calc.test.ts:103` | `fenToStr 对 -0.4 显示 0.00（当前实现返回 -0.00，疑似缺陷 #1）` | **已转正**：`src/db/util.ts` 的 `fenToStr` 已改为「先 `Math.round` 再判符号」，用例改名 `fenToStr 先取整再判符号：非整数分不会出现 -0.00` 并升级为 5 条强断言（见 4.6）。当前全仓 **`it.skip` 0 条**、`pnpm test` 0 skipped。 |

---

## 五、疑似缺陷 / 风险清单（0 条未关闭 + 1 条已核实不成立）

| # | 名字 | 级别 | 状态 / 说明 |
|---|---|---|---|
| 1 | `fenToStr` 负数不足一分显示 `-0.00` | Low | **已关闭（实现已修）**。`src/db/util.ts` 改为「先 `Math.round` 再判符号」（`rounded < 0 ? '-' : ''`，`-0` 天然落到 `'0.00'`），用例 4.6 已由 skip 转正并升级为 5 条强断言。 |
| 2 | 回推节流表 `lastRepushAt` / 缺列降级标志为模块级、测试不可复位 | Low（可测性） | **已关闭（实现已补钩子）**。`src/db/sync.ts:682` 已导出 `__resetSyncFlagsForTest()`（复位 `recordColumnMissing` / `schemaColumnMissing` / `lastRepushAt`），`tests/setup.ts` 的全局 `afterEach` 每例调用。反向验证：注掉该行后降级组 3 红，恢复后全绿。`sync-inbound.test.ts` 里「每个用例用自己的 recordId」的注释已改为「已有钩子兜底，纯粹为提高可读性」。 |
| 3 | ~~H3「pending 跳过 + 水位推进 = 永久丢更新」~~ | **已核实不成立** | 实测不成立：`pullStartCursor()` 的 5 分钟重叠窗口让下一轮从更早（本例被夹到 0）重放，远端更新在 pending 清空后能正常落地。已由用例 1.5（301 条积压）**锁死该结论**：若将来去掉 `OVERLAP_MS` 或把它写进持久化游标，该用例立即变红。 |

---

## 六、覆盖率前后对比（`pnpm test:cov` 真实数字）

| 指标 | 改前（基线） | 第一批后 | 收尾后（本次） | 累计 Δ |
|---|---:|---:|---:|---:|
| 全局 lines | 84.30 | 88.07 | **89.53** | +5.23 |
| 全局 branches | 77.37 | 80.08 | **79.8**（多次运行 79.76–79.92 抖动） | +2.4 |
| 全局 functions | 80.55 | 83.33 | **85.08** | +4.53 |
| **`src/db/sync.ts` lines** | **68.28** | 78.40 | **82.63** | **+14.35** |
| `src/db/sync.ts` branches | 63.69 | 74.11 | 74.19 | +10.50 |
| `src/db/sync.ts` functions | 59.64 | 68.42 | 74.13 | +14.49 |
| `src/db/calc.ts` lines | 88.00 | 90.40 | 90.40 | +2.40 |
| `src/db/repo.ts` lines | 94.24 | 94.24 | 94.24 | 0（只拆用例、不加路径） |
| `src/db/util.ts` lines | 83.58 | 83.58 | 83.82 | +0.24（`fenToStr` 新分支被 4.6 覆盖） |

> 全局 branches 从 80.08 微降到 79.92 是正常现象：新增的降级重试用例把更多**新分支**纳入统计，其中少量错误路径（如 `MAX_ATTEMPTS` 用尽）仍未覆盖，分子涨得比分母慢一点；对应的 `sync.ts` branches 仍是 +10.5pt。

### 阈值设定依据（组 5）

- `vitest.config.ts` 的 `include` 改为 `['tests/**/*.test.{ts,tsx}']`。已实测：临时放入 `tests/__tmp-tsx-check.test.tsx` 能被收集并执行（13 files / 122 passed），验证后已删除，工作区无残留。
- `src/db/sync.ts` per-file 阈值定 **`lines: 75`**：第一批补齐后实测 **78.40%**，已高于 75，故按指令取 75（留缓冲，而不是「实际值 − 2」的 76.4）；收尾后实测 **82.63%**，缓冲扩大到 7.6pt —— 阈值仍留 75 不动，避免把门槛抬到需要靠脆弱用例维持的高度。functions/branches 仍沿用全局 60/50（实测 74.13 / 74.19，均有余量），不在本次加严范围。
- 门禁有效性已反向验证（临时抬到 99 → `ERROR ... does not meet "src/db/sync.ts" threshold (99%)`，exit=1），随后恢复 75 并复跑 exit=0。

**观察（未处理）**：`syncResolve.ts` 的 branches 多次运行的读数在 81.39 / 82.22 / 81.81 之间抖动，v8 对该文件默认参数分支的统计存在轻微抖动，属既有现象，与本次改动无关，也不影响任何阈值（全局 branches 50、实测 79.92）。

---

## 七、未做 / 建议后续接手

1. ~~**M2 降级重试**（推/拉两侧 `PGRST204` / `42703` 去列重试）仍无覆盖~~ → **本次已完成**：`src/db/sync.ts:682` 导出 `__resetSyncFlagsForTest()`，`tests/setup.ts` 全局 `afterEach` 调用；`tests/sync-cursor.test.ts` 新增 2.6–2.10 共 5 条（推送去列重试 / 已降级短路 / 纯网络错误降级 / 拉取 42703 / 拉取已降级短路）。
2. **L1 真实时钟**：`tests/repo.test.ts:277` 的 `setTimeout(2)` 与 `:515` 手改 `startedAt` 未动 —— `vi.useFakeTimers` 与 `fake-indexeddb` 的宏任务调度组合存在风险，且不在本次五组范围内。
3. **L3/L4/L5**（迁移标记旧值 `'yes'`、`importMerge` 幂等、`restoreSnapshot` 写 `yh-sync-disabled`）为 Low，本次未做。
4. **AGENTS.md 的用例数**：`pnpm test # 11 个测试文件 / 90 个用例` 需要同步为 **12 / 127（127 绿、0 skip）**；`docs/代码异味基线-20261110.md` 第十五节的自报覆盖率也需回写（本报告已给真实数字：sync.ts 82.63%、全局 89.53%）。这两处不在本次可改范围（`docs` 基线由批次负责人回写）。