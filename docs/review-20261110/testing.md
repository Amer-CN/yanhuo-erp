# 测试审查报告（2026-11-10）

> 审查范围：`tests/*.test.ts`（11 个）、`scripts/` 下 6 个 E2E/诊断脚本、`vitest.config.ts` / `vite.config.ts` / `tests/setup.ts` / `tests/helpers.ts` / `fake-indexeddb` 替身。
> 审查方式：**纯静态审查**，未执行 `pnpm test`、未执行任何 `python scripts/*.py`（避免污染真实账本与耗时）。
> 约束遵守：已先读 `docs/代码异味基线-20261110.md`，「已消除」29 条与「已关闭」2 条**无一条被重复报告**；本报告只报测试维度问题，全部条目均经源码/测试文件对照核实。

---

## 一、核对结论

**11 个测试文件 / 90 个用例属实。**

核实方式（`it(` 出现次数统计 + 表驱动展开）：

| 测试文件 | `it(` 调用数 |
|---|---:|
| `tests/backup.test.ts` | 4 |
| `tests/calc.test.ts` | 9 |
| `tests/clear-cloud.test.ts` | 3 |
| `tests/merge.test.ts` | 7 |
| `tests/outbox.test.ts` | 4 |
| `tests/repo.test.ts` | 21 |
| `tests/session-migrate.test.ts` | 4 |
| `tests/session.test.ts` | 12 |
| `tests/sync-cursor.test.ts` | 9 |
| `tests/sync-resolve.test.ts` | 3 |
| `tests/sync-unknown-kind.test.ts` | 2 |
| **合计（`it(` 字面出现）** | **78** |

`tests/sync-resolve.test.ts:132` 的 `for (const c of cases) { it(c.name, ...) }` 是表驱动：该文件 3 处 `it(` 实际展开为 13 条 case + `businessTime` 1 条 + `nextBackoff` 1 条 = **15 条**。

故真实用例总数 = 78 − 3 + 15 = **90**，与 `AGENTS.md:26`、基线第九节「11 个测试文件 / 90 个用例」一致。

配置侧核对结论：

- `vitest.config.ts:5` `include: ['tests/**/*.test.ts']` —— 只收 `.ts`，不收 `.tsx`；当前无组件测试。
- `vitest.config.ts:6` `environment: 'node'` —— 无 DOM，`fake-indexeddb` 由 `tests/setup.ts` 注入。
- `vitest.config.ts:10-12` `coverage.include: ['src/db/**/*.ts']`，排除 `types.ts` / `seed.ts` —— **`src/ui/**` 全部不进覆盖率**。
- `vitest.config.ts:13-17` 阈值 `lines 60 / functions 60 / branches 50`。
- CI：`.github/workflows/deploy.yml:49` 跑 `pnpm test:cov`（含阈值），`:45` 跑 `pnpm lint`；E2E 由 `.github/actions/e2e/action.yml` 跑 4 个脚本（check-default-sync / e2e-smoke / e2e-sync / e2e-offline），**不含 `e2e-merge.py`，也不含 `a11y-check.py`**。

---

## 二、发现清单

### High

#### H1｜删除与再同步：远端 `deleted` 行的落地路径零覆盖

- **编号**：H1
- **文件:行号**：`src/db/sync.ts:499-503`（`planRemoteChanges` 的 `if (row.deleted)` 分支）、`src/db/sync.ts:484-496`（`dropLinesOfOrder` 级联）、`src/db/sync.ts:554-563`（`applyPlannedChanges` 先删后写）
- **问题**：删除传播完全没有测试。全仓 `tests/*.ts` 中唯一出现 `deleted: true` 的地方是 `tests/clear-cloud.test.ts:58`，那是**出站请求体**（`PATCH` 的 body），不是拉取侧入站的 `RemoteRow`。没有任何用例向 `syncNow` 喂过一条 `deleted: true` 的远端行。
- **具体缺失场景**：
  - 远端 `kind='order'` 且 `deleted=true` → 应删本地 `orders` 并级联删 `lines`（`dropLinesOfOrder`），且**不该**把该 order 的明细留在库里；
  - 远端 `kind='line'` 且 `deleted=true` → 只删该明细，不动其它明细；
  - 同一页里「order 删除」之后又出现该 order 的 line 行 → 按 `sync.ts:483` 注释声明的顺序语义，该明细会被重新写入（这是设计承诺，无断言锁死）；
  - 删除后再次同步同一批 tombstone → 幂等（不报错、不产生新的 outbox）。
- **建议补的用例**：
  - `it('pull 收到 deleted 的 order 时连带删除本地明细')` —— 预置本地 `o1 + l1/l2`，喂入 `{kind:'order',record_id:'o1',deleted:true}`，断言 `db.orders.get('o1')` 为 `undefined`、`db.lines.where('orderId').equals('o1').count()` 为 `0`、`db.outbox` 不因删除而入队。
  - `it('删除后重复应用同一批 tombstone 是幂等的')` —— 连续两次 `syncNow` 返回同一页，断言第二次不抛错、`db.orders.count()` 仍为 0。
  - `it('同页内 order 删除之后紧跟的 line 仍会被重新写入')` —— 断言该 line 存在（锁死 `sync.ts:483` 的顺序语义，防止将来顺手改成「先全删再全写」破坏兼容）。

#### H2｜两台设备同时改同一条记录：冲突只在决策层被验证，落库未验证

- **编号**：H2
- **文件:行号**：`src/db/sync.ts:514-522`（`decision === 'conflict'` 时 `conflictRows.push`）、`src/db/sync.ts:567`（`db.conflicts.bulkAdd`）、`src/db/db.ts:21-31`（`SyncConflictRow` 结构）
- **问题**：`grep "conflicts" tests/*.ts` **零命中**。冲突链路只测了纯函数 `resolveRemote` 的返回值（`tests/sync-resolve.test.ts:51-57` 的「时间相同、作废状态相同、内容不同 → 冲突留痕」），**但没有任何用例验证**：`db.conflicts` 真的写进了一行、`local`/`remote` 字段真的序列化了双方快照、本地记录真的没被远端覆盖、且后续同步不会把冲突行清掉。
- **具体缺失场景**：
  - 两端同 `record_updated_at`、同 `voided` 状态、内容不同 → 应写 1 条冲突留痕且**保留本地值**；
  - 冲突行落库后，本地 `updatedAt` 不变（不因冲突而抖动，避免触发无谓推送）；
  - 冲突只影响该记录，同页其它记录照常写入；
  - `clearAllData()` 清空冲突计数（与 M6 联动，见 `src/db/repo.ts:868`）。
- **建议补的用例**：
  - `it('两端同毫秒改同一单：写一条冲突留痕且本地值不变')` —— 本地 `o1.totalFen=1000`，远端同 `record_updated_at` 但 `totalFen=2000`，断言 `db.conflicts.count() === 1`、`JSON.parse(row.local).totalFen === 1000`、`JSON.parse(row.remote).totalFen === 2000`、`db.orders.get('o1').totalFen === 1000`。
  - `it('冲突不阻断同页其它记录落地')` —— 同页再给一条无冲突的 `o2`，断言 `db.orders.get('o2')` 存在。
  - `it('冲突留痕的 kind/recordId/at 字段完整')` —— 断言 `row.kind === 'order'`、`row.recordId === 'o1'`、`Number.isNaN(Date.parse(row.at)) === false`。

#### H3｜发件箱积压 / 本地待推送时 pull 跳过远端，且仍推进游标（缺测试 + 真实风险）

- **编号**：H3
- **文件:行号**：`src/db/sync.ts:584-585`（`active = rows.filter(r => !pending.has(...))`）、`src/db/sync.ts:778-779`（`cursor = nextCursor(...)` + `setLastPullCursor` 无条件推进）、`src/db/sync.ts:61`（`OUTBOX_BATCH = 300`）、`src/db/sync.ts:402-404`（`orderBy('queuedAt').limit(OUTBOX_BATCH)`）
- **问题**：「本地还有没推上去的改动时以本地为准」这条分支未被任何用例覆盖；而它与游标推进组合后存在**真实丢更新风险**：`syncNow` 先 `pushOutbox`（最多 300 条）再 `pull`，若发件箱超过 300 条、或上一批推送抛错，则 pull 阶段仍有 pending 记录 → 这些 id 的远端版本被 `active` 过滤掉，但 `nextCursor` 照样把水位推过它们，下一轮不会重拉 → 远端对该记录的更新永久丢失（直到有人再改一次）。
- **具体缺失场景**：
  - 本地有 pending 的 order 时，pull 的远端版本**不得**覆盖本地；
  - pending 清除后（第二轮同步），rt 能取到远端版本（验证"只是跳过、不是丢弃"）；
  - 发件箱 301 条时的两轮同步：第一轮只推 300 条并跳过被跳过的远端更新，第二轮补推后能对齐；
  - 重复推送同一 payload（幂等）不产生重复业务数据。
- **建议补的用例**：
  - `it('本地有待推order时 pull 不覆盖本地值')` —— `enqueue('order','o1')` 后喂远端 `o1.totalFen=2000`，断言本地仍为 1000。
  - `it('发件箱积压 301 条时，第二轮同步仍能取到远端更新')` —— 构造 301 条 outbox + 远端同 id 更新，断言第一轮后本地未变、第二轮后本地等于远端；**该用例若失败，说明 H3 描述的是真 bug 而不是纯覆盖缺口**。
  - `it('同一 payload 推送两次不产生重复业务数据')` —— 断言 `db.orders.count()` 不翻倍、outbox 第二次为 0。

#### H4｜`scripts/e2e-merge.py` 已随 v1 UI 删除而不可运行

- **编号**：H4
- **文件:行号**：`scripts/e2e-merge.py:54-69`（`sell_product()` 使用 `.checkout-bar`、`结算`、`收款 ¥`、`现金收款`、`正好`、`确认收款`、`收款完成`）
- **问题**：脚本仍走 v1 即时收银流程。对 `src/**/*.tsx` 全量检索 `结算|收款|checkout-bar` 的结果是 **0 命中**；`.prod-btn` 仅存在于 `src/ui/ProductPicker.tsx:111`，且只出现在「添加商品」弹层内部，首页没有。因此 `sell_product(a, 0)` 在 `page.locator(".prod-btn").nth(0).click()` 处必然 30s 超时 → **脚本目前无法跑通**，而 `AGENTS.md:26` 仍把它列为可用命令。
- **具体缺失场景**：该脚本本应验证「导出 → 导入合并 → 不重复、金额相加」，现在这条价值链**完全没有可运行的 E2E**；单测只覆盖了 `importMerge` 的数据层（`tests/merge.test.ts`），"设置页导出按钮 → 文件 → 导入按钮 → 合并预览 → 合并"的 UI 契约无人验证。
- **建议**：改写 `sell_product()` 为 v2 流程 —— `.prod-btn` 前先点「记一笔」→「添加商品」→ 选商品 →「完成（回单据）」→「保存并记下一单」→ 等 `已记` toast →「返回」；或从 `AGENTS.md` 移除该命令并注明"v1 脚本已废弃"。补 `it('设置页导出→导入合并后销售额为两设备之和且商品不重复')` 的 E2E 断言（保留现有 `26.50` / `共 8 个商品` 断言结构，但见 L7 的硬编码问题）。
- **备注**：CI 未引用该脚本（`action.yml` 只跑 4 个），所以不会让流水线变红，属**文档失真 + 价值链缺口**。

### Medium

#### M1｜推送失败时发件箱保留、重试后清空 —— 无断言

- **编号**：M1
- **文件:行号**：`src/db/sync.ts:402-417`（`pushOutbox`：`await postWithSchemaFallback(...)` 在前，`db.outbox.bulkDelete(...)` 在后）、`src/db/sync.ts:63`（`MAX_ATTEMPTS = 4`）
- **问题**：`bulkDelete` 只在 POST 成功后执行，这是"断网不丢单"的隐含契约，但 `tests/outbox.test.ts` 只测了入队去重/批量入队/清空，**没有一条用例验证推送失败后发件箱仍然保留**。
- **具体缺失场景**：500/网络错误时 outbox 不丢；成功后同一批才被删；失败 → 成功两轮之间 payload 一致（不因重试而丢字段）。
- **建议补的用例**：
  - `it('推送 500 时发件箱不清空，重试成功后清空')` —— `fetch` 先返回 `new Response('boom',{status:500})`，`await expect(syncNow(CFG)).rejects.toThrow()`，断言 `await pendingCount() === 1`；再让 `fetch` 返回 201，断言 `pendingCount() === 0`。
  - `it('重试请求的 body 与首次完全相同')` —— 记录两次 `init.body` 的 `JSON.parse` 结果做 `toEqual`（排除 `updated_at` 需先剥离该字段）。

#### M2｜schema 缺列降级重试无覆盖，且降级标志无法在用例间复位

- **编号**：M2
- **文件:行号**：`src/db/sync.ts:377-400`（`postWithSchemaFallback` 循环）、`src/db/sync.ts:311-312`（`let recordColumnMissing` / `let schemaColumnMissing` 模块级）、`src/db/sync.ts:315-333`（`missingColumns` / `stripMissingColumns`）、`src/db/sync.ts:696-713`（拉取侧 `fetchRemotePage` 对称降级）
- **问题**：两边（推/拉）的降级重试**都没有测试**；更麻烦的是两个降级标志是模块级可变状态，测试环境无法复位（`sync-cursor.test.ts` 与 `sync-unknown-kind.test.ts` 共用同一模块实例）——一旦新增用例触发降级，同文件后续用例会静默使用 legacy 列清单，产生"改一行代码，另一个用例莫名其妙变绿"的假象。
- **具体缺失场景**：首次 400(PGRST204 + `record_updated_at`) → 去掉该列重试成功；已降级后**不再**先撞一次 400（`sync.ts:367` 的短路）；错误文本不含列名（纯网络错误）时**不**降级而是上抛（`sync.ts:317` 的 `if (!msg.includes('PGRST204')) return null`）；拉取侧 `42703` / `does not exist` / `schema cache` 三种文本都命中降级（`sync.ts:640-645`）。
- **建议补的用例**：
  - `it('首次 PGRST204 缺 record_updated_at 时去列重试一次，第二次请求不再带该列')` —— 断言 `fetch` 共调用 2 次、第二次 body 无 `record_updated_at`。
  - `it('纯网络错误不做降级')` —— 喂 `new Error('Failed to fetch')`，断言只发 1 次请求且异常上抛。
  - 配套改造：为两个标志导出 `__resetSyncFlagsForTest()`（或在用例内 `vi.resetModules()` 重新 import），并在 `tests/setup.ts` 的 `afterEach` 调用。

#### M3｜离线分支（`navigator.onLine === false`）无测试

- **编号**：M3
- **文件:行号**：`src/db/sync.ts:792-793`（`if (!navigator.onLine) throw new Error('当前离线')`）
- **问题**：两处 stub 都把 `navigator` 固定成 `{ onLine: true }`（`tests/sync-cursor.test.ts:21`、`tests/sync-unknown-kind.test.ts:23`），**没有一条用例走过 false 分支**。断网补发只在 `scripts/e2e-sync.py:202-216` 由浏览器 `set_offline` 覆盖，单测层为零。
- **具体缺失场景**：离线时 `syncNow` 立即抛错、不推进水位、不删发件箱、不写 `yh-sync-last-sync`；恢复在线后同一批 outbox 能正常推送。
- **建议补的用例**：
  - `it('离线时 syncNow 抛「当前离线」且不动水位与发件箱')` —— stub `navigator.onLine=false`，先 `enqueue('order','o1')`，断言 rejects、`store.get('yh-sync-last-pull')` 仍为 undefined、`pendingCount() === 1`。
  - `it('恢复在线后同一批发件箱可正常推送')` —— 先 false 再 true，断言 `pushed === 1`。

#### M4｜`yh-sync-disabled` 红线开关与 `clearSyncConfig` 无单测

- **编号**：M4
- **文件:行号**：`src/db/sync.ts:75-96`（`getSyncConfig`，其中 `:77` 是 `disabled === '1'` 早返回）、`src/db/sync.ts:115-125`（`clearSyncConfig` 清 5 个游标键 + 置 disabled）
- **问题**：这是项目红线（"测试数据不得写真实账本"）唯一的技术闸门，却**没有任何测试**。同样未测的还有 `clearSyncConfig()` 是否会连带清掉 `yh-sync-last-pull` / `last-pull-id` / `cleared-at`（换了账本后不清游标会导致新账本"什么都拉不到"）。
- **具体缺失场景**：`disabled='1'` 时返回 `null`（即使内置默认配置存在）；未禁用且无手动配置时返回 `DEFAULT_SYNC`；`saveSyncConfig` 会 `removeItem(disabled)`；`clearSyncConfig` 后只剩 `disabled='1'`。
- **建议补的用例**：
  - `it('yh-sync-disabled=1 时不返回任何配置')` —— 断言 `getSyncConfig() === null`（这是"测试不写真实账本"的守门断言）。
  - `it('clearSyncConfig 清掉全部游标键并置 disabled')` —— stub localStorage，断言 `yh-sync-last-pull`/`-id`/`cleared-at`/`-last-sync`/`-error` 均为 `null` 且 `disabled === '1'`。

#### M5｜`resetDb()` 未清 `conflicts`，与生产表结构口径不一致

- **编号**：M5
- **文件:行号**：`tests/helpers.ts:8-19`（`resetDb` 清 7 张业务表 + outbox，**未清 `db.conflicts`**）
- **问题**：主库实际有 9 张表（`src/db/db.ts:37-45` 含 `outbox` 与 `conflicts`）。`resetDb` 漏了 `conflicts`，`backupDb.snapshots` 也靠在 `tests/backup.test.ts:95` 手工补。一旦补上 H2 的冲突用例，前一条用例留下的冲突行会让后一条的 `count()` 断言错乱，且**故障现象是"随机变红"**、极难定位。
- **具体缺失场景**：用例间冲突计数归零；快照表归零。
- **建议补的用例/改造**：
  - 在 `resetDb` 中补 `db.conflicts.clear()`（`backupDb.snapshots` 也一并纳入，或提供 `resetAll()`）。
  - 补 `it('resetDb 后 conflicts 与 outbox 均为 0')` 作为脚手架自检用例，防止将来新增表又漏清。

#### M6｜`clearAllData` 用例含两条恒真断言，且两条显式契约无断言

- **编号**：M6
- **文件:行号**：`tests/repo.test.ts:487-488`（`expect(Array.isArray(all.sessions)).toBe(true)` / `Array.isArray(all.settings)`）、`tests/repo.test.ts:496`（`expect(order.id).toBeTruthy()`）、对应实现 `src/db/repo.ts:855-876`
- **问题**（**无效断言**）：
  1. `Array.isArray(all.sessions)` 恒为真（`loadAll` 的返回类型就是数组），任何实现错误都测不出来，等于没断言；
  2. `expect(order.id).toBeTruthy()` 与本用例主题（`clearAllData`）无关，是删除/清库后残留的一行噪声；
  3. 该用例标题把「loadAll 返回全部 7 张表」与「clearAllData 清库并重置迁移标记」两件事捆在一个 `it` 里，失败时无法定位是哪一半坏了。
  4. `clearAllData` 的两条**显式契约**反而没有断言：`db.conflicts.clear()`（`repo.ts:868`，L-002 的修复）与「两次 `setSetting` 会 `enqueue`，所以 `db.outbox.clear()` 必须最后执行」（`repo.ts:872-875`，基线第十二节的踩坑记录）。
- **建议补的用例**：
  - `it('loadAll 返回 7 张表且每张表条数与 count() 一致')` —— 逐表 `expect(all.products.length).toBe(await db.products.count())`，替换掉 `Array.isArray`。
  - `it('clearAllData 清空业务表与冲突留痕，发件箱最终为 0')` —— 先 `db.conflicts.add(...)` 造一条冲突，再 `clearAllData()`，断言 `db.conflicts.count() === 0`、`db.outbox.count() === 0`、`getSetting(seeded) === ''`、`getSetting(sessionsMigrated) === ''`（这条断言同时锁死 outbox 清理顺序，改动顺序即变红）。

#### M7｜`expiryWarnings` 只断言「一条都没有」，正例从未被验证

- **编号**：M7
- **文件:行号**：`tests/calc.test.ts:139-149`（断言仅 `expect(warns).toHaveLength(0)`）、实现 `src/db/calc.ts:311-331`
- **问题**：唯一一条 `expiryWarnings` 用例的断言是**空集**，注释还写着「b1 已卖光；b3 没有效期；b2 在 30 天外」。也就是说：窗口内的批次**从未被断言命中过**，`daysLeft` 的数值/符号、结果按 `daysLeft` 升序（`calc.ts:330`）、`warnDays` 边界（`expiryDate === limit` 那天算不算）、`today` 缺省调用真实 `localDate()`（`calc.ts:316`，时间相关）全部无覆盖。这条用例即使把实现改成 `return []` 也依然全绿。
- **具体缺失场景**：剩余>0 且在窗口内 → 命中；已过期（`daysLeft < 0`）→ 命中且排最前；`remaining <= 0` → 排除；无 `expiryDate` → 排除；`expiryDate === addDays(today, warnDays)` 的边界。
- **建议补的用例**：
  - `it('窗口内的临期批次按 daysLeft 升序返回')` —— 传固定 `today='2026-01-10'`，造 3 条（+5 天、−2 天、+31 天），断言 `warns.map(w => w.batch.id)` 顺序为 `['过期','+5天']` 且 `warns[0].daysLeft === -2`。
  - `it('warnDays 边界：恰好等于预警上限的批次也算命中')` —— 断言 `daysLeft === 30` 时被包含（锁死 `calc.ts:324` 的 `>` 与 `>=` 口径）。
  - `it('卖光的批次与无有效期的批次被排除')` —— 保留现有断言，另加两条正例，避免"空集通过"。

#### M8｜金额计算精度与边界缺口（负数 / 尾点 / 千分位 / 超大数 / 半入方向）

- **编号**：M8
- **文件:行号**：`tests/calc.test.ts:59-67`（`strToFen` 仅 7 个输入）、`tests/calc.test.ts:52-57`（`fenToStr` 仅 4 个输入）、实现 `src/db/util.ts:52-73`；舍入口径在 `src/db/repo.ts:358`（`Math.round(l.qtyBase)`）、`:377-379`（`qty` / `unitPriceFen`）、`:369-370`（`amountFen` / `listAmount`）
- **问题**：
  - `strToFen` 未测**负数**（实现 `util.ts:65-72` 专门处理负号、`fenToStr` 也支持负号，两边不对称覆盖）、未测 `'1.'`（正则 `^-?\d*(\.\d{0,2})?$` 允许尾点，会得到 100 分）、未测千分位分隔符 `'1,234.50'`（`util.ts:62` 显式 `replace(/[¥￥,，\s]/g,'')`）、未测超大数（`'999999999999.99'` 的 `yuan*100` 是否仍安全）、未测 `'0.001'`（应 null）；
  - 四舍五入口径无断言：`Math.round(-2.5) === -2`（向 +∞ 取整，不是四舍五入），`Math.round(10.5) === 11`；`createAdjustment` 的 `-2.4 → -2`（`repo.ts:828`）只被 `tests/repo.test.ts:469` 试过一次，负数半入方向缺覆盖。
- **具体缺失场景**：负数、尾点、千分位、超大数、多于两位小数的拒绝、`-0.5`/`-2.5` 的取整方向、`fenToStr` 对 `1e9` 以上与 `0.4` 的取整。
- **建议补的用例**：
  - `it('strToFen 支持负号、尾点与千分位，并拒绝三位小数')` —— 断言 `strToFen('-3.05') === -305`、`strToFen('1.') === 100`、`strToFen('1,234.50') === 123450`、`strToFen('0.001') === null`、`strToFen('999999999999.99') === 99999999999999`。
  - `it('fenToStr 处理超过 1e9 的分值与小数取整')` —— 断言 `fenToStr(1_000_000_000) === '10000000.00'`、`fenToStr(0.4) === '0.00'`、`fenToStr(-0.4) === '0.00'`。
  - `it('金额与数量按 Math.round 半入：-2.5→-2、10.5→11')` —— 用 `createAdjustment`/`saveRecord` 或直接断言 `buildLines` 产物，锁死负数方向（这是最容易随"改成四舍五入"而无人察觉的地方）。

#### M9｜`undoPatchedRecord` 全仓零测试

- **编号**：M9
- **文件:行号**：`src/db/repo.ts:504-533`（`undoPatchedRecord`）、分支 `:508-511`（open 场次退化为 `deleteRecord`）
- **问题**：`grep -r "undoPatchedRecord" tests/` **零引用**。它同时改 3 件事：删单+删明细、`patchedCount - 1`（带 `Math.max(0, …)` 兜底）、重算并写回 `summary`、入队 `session`；还有一个"open 场次直接走 `deleteRecord`"的短路分支。
- **具体缺失场景**：已结账场次撤销补记 → 计数减 1、快照金额回退、明细清空、outbox 有 session/order/lines 的删除记录；`patchedCount` 已为 0 时再撤销 → 仍为 0（`Math.max` 兜底）；open 场次撤销 → 走删除而非减计数；订单不存在 → 静默返回。
- **建议补的用例**：
  - `it('撤销补记：patchedCount 减 1 且快照金额回退')` —— 结账后 `addPatchedRecord` 两单，撤销一单，断言 `patchedCount === 1`、`summary.revenueFen` 等于撤销后的真实值、`db.lines.where('orderId').equals(id).count() === 0`。
  - `it('patchedCount 为 0 时撤销不会变负')` —— 断言 `patchedCount === 0`。
  - `it('open 场次的补记撤销走删除分支')` —— 断言 `db.orders.get(id)` 为 `undefined` 且 `db.sessions` 的 `patchedCount` 未变。

#### M10｜开单草稿逻辑（含金额重算）零测试，且不进覆盖率

- **编号**：M10
- **文件:行号**：`src/ui/recordDraft.ts:42-46`（`draftKey`）、`:77-105`（`loadDraft` 兼容与兜底）、`:118-121`（`amountFromText`）、`:123-125`（`draftLineAmount`）、`:128-155`（`draftFromOrder`）；另 `src/ui/useRecordDraft.ts` 的 `syncAmount`（金额联动，C7 收敛点）；覆盖率口径 `vitest.config.ts:10`
- **问题**：整套草稿逻辑（断网开单中途被打断后的恢复）没有一条测试。`loadDraft` 有大量防御分支（`lines` 非数组/为空 → null、坏 JSON → null、`payMethod` 白名单、字段类型逐项 fallback、旧键兼容），`draftKey` 的三种隔离键（`new`/`edit:orderId`/`patch:sessionId`）是"避免串单"的核心承诺，全部无断言。同时 `coverage.include` 只含 `src/db/**`，这部分即便有 bug 也不会让 `pnpm test:cov` 掉点。
- **具体缺失场景**：edit/patch 键互不覆盖；旧键兼容读取；坏 JSON / 空 lines 返回 null；`amountFromText('abc') === -1`；`draftFromOrder` 产出 `amountTouched: true`（改数量时不覆盖手改的金额）。
- **建议补的用例**（**不需要引入新框架**，stub `sessionStorage` 即可）：
  - `it('edit/patch 草稿键按 orderId/sessionId 隔离，互不覆盖')` —— 写 `edit:o1` 与 `edit:o2`、`patch:s1`，断言三次 `loadDraft` 各自读回自己的内容。
  - `it('loadDraft 遇到坏 JSON / 空 lines 返回 null，并能读回旧键')` —— 断言 `loadDraft('yh-record-draft:new')` 在只有旧键 `yh-record-draft` 时仍能取到。
  - `it('amountFromText 对非法输入返回 -1，draftLineAmount 用标价×数量生成文本')` —— 断言 `amountFromText('abc') === -1`、`draftLineAmount(3, 2500) === '75.00'`。
  - `it('draftFromOrder 标记 amountTouched，且 gift 行金额文本为 0.00')` —— 锁死"改数量不覆盖手改金额"的预设。

#### M11｜`include` 不匹配 `*.test.tsx`，未来组件测试会被静默跳过

- **编号**：M11
- **文件:行号**：`vitest.config.ts:5`（`include: ['tests/**/*.test.ts']`）
- **问题**：只匹配 `.test.ts`。将来任何人新增 `tests/Foo.test.tsx`，`pnpm test` 都会**不报错、不执行、不计覆盖率**（Vitest 找不到文件即视为通过）——这是门禁的隐性黑洞，比没有测试更危险，因为它会让人误以为已经覆盖。
- **具体缺失场景**：`.tsx` 测试文件被收集。
- **建议补的用例/改造**：把 `include` 改为 `['tests/**/*.test.{ts,tsx}']`（当前无 `.tsx` 测试，改动零风险），并补一条脚手架自检说明；若将来要测组件，再对单个文件加 `// @vitest-environment jsdom` 头注释，不必全局切环境。

#### M12｜覆盖率阈值 60/60/50 低于同步模块的实际水位，门禁对最危险区域无效

- **编号**：M12
- **文件:行号**：`vitest.config.ts:13-17`（`lines 60 / functions 60 / branches 50`）、`vitest.config.ts:10`（只统计 `src/db/**`）、CI `deploy.yml:49`（`pnpm test:cov`）
- **问题**：基线第十五节自报 `sync.ts 66.10%`，而全局阈值是 60% —— 也就是说同步模块再退化 6 个点仍能过 CI；同时 `src/ui/**` 完全不进统计（M10 因此无点可掉）。本项目最危险的区域恰好是同步/数据一致性，门禁却在它最弱的地方留了 6 个点的缓冲。
- **具体缺失场景**：同步模块覆盖率回退不被告警。
- **建议补的用例/改造**：为 `src/db/sync.ts` 单独设 `lines ≥ 75`（`coverage.thresholds` 支持 per-file 配置）；补齐 H1/H2/M1/M2/M3 后应能自然达标（那批路径正是未覆盖的三分之一）。

### Low

#### L1｜真实时钟依赖：`setTimeout(2)` 与手改 `startedAt`

- **编号**：L1
- **文件:行号**：`tests/repo.test.ts:277-279`（`await new Promise(r => setTimeout(r, 2))`，注释写明"曾导致 CI 随机红"）、`:284`（`expect(updated?.updatedAt).not.toBe(p.updatedAt)`）、`:515-521`（手工把 `startedAt` 改成 `2020-01-01` 来制造顺序）
- **问题**：用真实时钟推进 + 真实 `sleep` 来绕开 `nowIso()` 的毫秒精度，是最典型的偶发红来源；`reopenSession` 判据 `db.sessions.where('startedAt').above(...)` 依赖真实时间，只能靠"改数据"来控制。
- **建议补的用例/改造**：`vi.useFakeTimers()` + `vi.setSystemTime(...)`，或提供 `advanceClock(ms)` 帮助函数；把 `:284` 改成"推进时钟后 `updatedAt` 等于新时刻"的确定断言（而不是"不等于旧值"）。

#### L2｜「进货默认按本地日期入账」只断言了 `toBeTruthy()`

- **编号**：L2
- **文件:行号**：`tests/repo.test.ts:304`（用例名）、`:320`（`expect(b.receivedAt).toBeTruthy()`）、实现 `src/db/repo.ts:155` 起 / `src/db/util.ts:21-26`
- **问题**：`localDate()` 的**本地时区**语义（相对 UTC 差 8 小时，跨零点即不同日）完全没锁。断言 `toBeTruthy()` 对"是 UTC 日期还是本地日期"、"格式对不对"都无感。
- **建议补的用例**：`it('进货默认按本地日期入账')` —— 断言 `b.receivedAt === localDate()`；再加 `it('本地日期与 UTC 日期跨零点时取本地')`（`vi.setSystemTime` 设为本地 00:10，断言不是 UTC 前一天）。

#### L3｜迁移标记用例写的是旧值 `'yes'`，实际没测到标记比较

- **编号**：L3
- **文件:行号**：`tests/session-migrate.test.ts:84`（`db.settings.put({ key: SETTING_KEYS.sessionsMigrated, value: 'yes' })`）、`:86`（断言 `migrateSessions() === 0`）、实现 `src/db/repo.ts:734-743`（比较 `SESSIONS_MIGRATED_VALUE`）
- **问题**：M-004 修的正是 `'yes'` vs `'1'` 的死比较。该用例仍写 `'yes'` 却断言返回 0 —— 它之所以通过，是因为 `o-existing` 已经有 `sessionId`，`pending.length === 0` 直接走短路分支；**标记比较本身没被验证**。若把实现改回旧的死比较，这条用例依然绿。
- **建议补的用例**：`it('标记为旧值 yes 时仍会执行迁移')` —— 造 1 条无 `sessionId` 的旧单 + 标记 `'yes'`，断言 `migrateSessions() === 1`（真迁移）；再加 `it('标记为 1 且有待迁移订单时短路返回 0')`（锁死幂等，注意：当前实现是"先看 pending 再看 done"，所以标记为 1 时仍会迁移 —— 这条要按真实语义写，若行为与预期不符，说明这里还有一个语义问题需要确认）。

#### L4｜`merge` 的弱断言与缺失的幂等用例

- **编号**：L4
- **文件:行号**：`tests/merge.test.ts:83-84`（`expect(...name).not.toBe('更旧')` / `not.toBe('一样新')`）、`src/db/merge.ts:146-149`（`sessionsUpdated++` 无条件累加）
- **问题**：`not.toBe('更旧')` 只排除了一个值，没断言**保留的原值**（应等于 `makeProduct('p3')` 的默认名）；`importMerge` 对同 id 的 session 无条件 `sessionsUpdated++`，即便合并结果与本地完全相同也算"更新"——没有"同一份备份合并两次"的幂等用例，而幂等正是 `importMerge` 存在的全部理由。
- **建议补的用例**：
  - 把 `:83-84` 改成 `expect((await db.products.get('p3'))?.name).toBe('商品p3')`（正向断言原值）。
  - `it('同一份备份合并两次：第二次 Added 全为 0 且数据全等')` —— 断言第二轮 `ordersAdded/linesAdded/batchesAdded === 0`，`db.orders.toArray()` 与第一轮后 `toEqual`。

#### L5｜`backup.test.ts` 重复注入、用例内删库、以及 `restoreSnapshot` 的停同步行为无断言

- **编号**：L5
- **文件:行号**：`tests/backup.test.ts:1`（重复 `import 'fake-indexeddb/auto'`，`tests/setup.ts` 已引入）、`:169-190`（用例内 `db.close()` + `db.delete()` + 重建 v2 库 + 末尾 `db.open()`）、`src/db/backup.ts:97-107`（`restoreSnapshot` 写 `yh-sync-disabled='1'`）
- **问题**：
  1. 重复注入无害但说明 setup 口径不统一；
  2. `:169` 的用例把主库删掉重建，**依赖它是文件里最后一个用例**（`beforeEach` 的 `db.*.clear()` 会失败或空转），一旦有人调整顺序或新增用例就会连锁失败；
  3. `restoreSnapshot` 会 `localStorage.setItem('yh-sync-disabled','1')`（`backup.ts:102`），但 Node 环境没有 `localStorage`，`try/catch` 直接吞掉 → "恢复备份后自动关闭云同步"这条**安全行为没有任何断言**（这是防"旧快照覆盖另一台设备新数据"的关键护栏）。
- **建议补的用例**：
  - 把 `:169` 拆到独立文件（如 `tests/backup-migrate.test.ts`），或在该用例内 `afterEach` 重新 `db.open()`。
  - `it('restoreSnapshot 后自动写入 yh-sync-disabled=1')` —— stub `localStorage`，断言 `getItem('yh-sync-disabled') === '1'`。

#### L6｜`e2e-sync.py` 的真实模式无生产账本护栏（可能整体软删真账本）

- **编号**：L6
- **文件:行号**：`scripts/e2e-sync.py:28-31`（读 `SYNC_URL/SYNC_KEY/SYNC_LEDGER`）、`:51-81`（`cleanup_cloud()` 对整个账本 `PATCH deleted=true`）、`:222`（`finally` 中调用）、`src/db/syncDefaults.ts:4-8`（内置生产账本码）
- **问题**：真实模式下 `cleanup_cloud()` 会对 `SYNC_LEDGER` 指向的**整个账本**发 `PATCH {deleted:true}`。脚本**不校验**该 ledger 是否等于内置生产账本（`syncDefaults.ts:7`）。一旦有人把 `SYNC_LEDGER` 误设为生产账本码（环境变量容易复制错），E2E 结束时会**整体软删真账本**，且 `finally` 保证一定执行。这与 AGENTS.md 红线第 5 条"测试数据不得写真实账本"直接冲突。
- **具体缺失场景**：护栏缺失；也没有任何"这是红线唯一合法例外"的显式注释（该脚本确实需要写云，因为它验证的就是同步）。
- **建议补的用例/改造**：
  - 在 `main()` 开头加：`if REAL_LEDGER == '<内置 ledgerKey>': sys.exit('拒绝用生产账本跑 E2E')`（硬编码常量或从 `syncDefaults.ts` 读）。
  - 脚本头补一段注释："本脚本是全仓唯一不设 `yh-sync-disabled=1` 的脚本，因为它验证同步本身；真实模式必须使用**测试专用账本**。"

#### L7｜E2E 断言值全部硬编码自 `seed.ts`，改示例数据即静默变红

- **编号**：L7
- **文件:行号**：`scripts/e2e-smoke.py:81`（`¥26.50`）、`:108`（`¥26.50`）；`scripts/e2e-sync.py:186`（`1 单 · 合计 ¥25.00`）、`:196`（`¥26.50`）、`:206`/`:212`（`3 单 · 合计 ¥41.50`）；`scripts/e2e-merge.py:122`（`共 8 个商品`）、`:133`（`26.50`）；数据来源 `src/db/seed.ts:18-25`
- **问题**：`大地红 1000 响 = 2500 分`、`二踢脚 = 150 分`、`加特林 = 1500 分`、共 8 个商品，全部是 `SAMPLE` 里的字面量。脚本与 `seed.ts` 之间**没有共享常量**：改一次示例价格、或增减一个示例商品，三条脚本就会以"找不到文本"的形式失败，看起来像 UI 回归，实际只是数据变了。
- **建议补的用例/改造**：让 `seed.ts` 额外导出 `SAMPLE`（或一个 `seedTotals()`），脚本用 `node -e "..."` 读出来参与断言；或把断言从"写死数字"改成"读首页金额再比对汇总"（例如 `e2e-sync.py` 里已有 `history_total()` 读取能力，可以直接做 A/B 加总校验）。

#### L8｜E2E 中大量固定 `wait_for_timeout`，是 CI 慢机上的 flaky 源

- **编号**：L8
- **文件:行号**：`scripts/e2e-smoke.py:40`（150ms）、`:78`（400ms）、`:80`（400ms）、`:102`（300ms）、`:109`（300ms）、`:117`（300ms）；`scripts/e2e-sync.py:126`（400ms）、`:128`（500ms）、`:145`（300ms）、`:147`（400ms）、`:155`（1000ms 轮询步长）
- **问题**：`scripts/e2e_util.py:16-26` 的 `wait_for_toast` 已经用"等目标文案"替掉了"sleep 后读当前 toast"（这是很好的实践），但页面切换/返回仍靠固定 sleep。CI（`ubuntu-latest`，冷启动 + 2 个 browser context）是这些 sleep 最容易不够用的环境。
- **建议补的用例/改造**：把剩余的 sleep 换成 `wait_for_selector` / `expect(locator).to_have_text(...)` / `wait_for_function`；优先改 `e2e-smoke.py:78-80` 与 `e2e-sync.py:126-128`（都在"保存后返回首页"的时序上，最容易偶发）。

#### L9｜`a11y-check.py` 被文档写成门禁，但不在任何 CI 中

- **编号**：L9
- **文件:行号**：`scripts/a11y-check.py`（整文件）、`.github/actions/e2e/action.yml:67-81`（只跑 4 个脚本）、`AGENTS.md:30`、基线第九节（`docs/代码异味基线-20261110.md:167`）
- **问题**：`AGENTS.md` 与基线都写"交互改动后必跑 `a11y-check.py`"，但 CI 的 composite action 里没有它，`e2e.yml` / `deploy.yml` 也没有 → 纯靠人记，实际等于无门禁。它本身是纯本地页面检查（无外部依赖），接入成本很低。
- **建议补的用例/改造**：在 `action.yml` 里新增一步 `python scripts/a11y-check.py`（`pnpm build` + preview 已在同一 action 中准备好）；或在 `AGENTS.md` 明确标注该脚本为"人工门禁"，避免误以为已有 CI 保障。

#### L10｜一条用例塞多个行为，失败定位困难

- **编号**：L10
- **文件:行号**：`tests/repo.test.ts:262`（「商品新增会 trim 并夹紧数值；编辑标记非示例；被流水引用的删除改为停用」三段）、`:328`（「已卖出的批次不能删；没卖过的照常删除」两段）、`:476`（「loadAll 返回全部 7 张表；clearAllData 清库并重置迁移标记」）
- **问题**：这些 `it` 覆盖 2–3 个独立行为，任一断言失败只能靠行号猜是哪一段；且 `:476` 的两段之间毫无关系（与 M6 重叠）。反例（可保留）：`:172`「已结账场次作废/恢复会重算快照；open 场次不写快照」虽多断言但语义单一（同一个"快照重算口径"）。
- **建议补的用例/改造**：按"一个用例一个行为"拆成 3 条 / 2 条 / 2 条，命名统一为「动词 + 条件 + 预期」；拆分后 `test:cov` 的分支覆盖不变。

#### L11｜同一批夹具在 3 个文件各写一份，且默认值语义不一致

- **编号**：L11
- **文件:行号**：`tests/calc.test.ts:6-49`（`batch`/`order`/`line`）、`tests/session.test.ts:6-59`（同名，`line` 多一个 `gift` 参数，`discountFen` 算法不同）、`tests/backup.test.ts:17-42`（`product`/`order`）、与 `tests/helpers.ts:21-124` 的 `makeProduct`/`makeBatch`/`makeOrder`/`makeLine`/`makeSession` 并存
- **问题**：同一概念存在 **3 套**构造器，默认值语义不同（`calc.test.ts:47` 自动算 `discountFen = (list-unit)*qty`，`session.test.ts:56` 是 `Math.max(0, list*qty - amount)` 且 gift 时置 0）。新增用例时极易选错夹具，导致"同样的输入在两个文件里得出不同结论"。
- **建议补的用例/改造**：统一收敛到 `tests/helpers.ts`（补 `makeLine({ gift })` 与 `makeCalcFixture()`），三个测试文件只保留各自的**特异性**覆盖；`makeProduct` 的 `name: '商品${id}'` 这类默认值也应写进注释，避免 L4 那种"原值是什么"的歧义。

---

## 三、测试整体评价

数据层单测的**质量明显高于文件数所暗示的水位**：`tests/repo.test.ts` 的 21 条用例覆盖了「补录队尾/插队/超卖」三种快照重算分支和「删除前后 `lineCost` 与 `summary` 逐字段相等」这类真正难的等价性证明，`tests/sync-cursor.test.ts` 对同毫秒复合游标的 9 条边界（含 id 回退防御）也都是真断言，不是"函数被调用/不报错"。但覆盖分布严重偏斜：`repo`（93.71%）/ `merge`（97.27%）/ `calc` 被打透，而**同步拉取侧的「入站变更落地」几乎空白**——删除传播、冲突落库、pending 跳过、推送失败保留、降级重试、离线分支这六条全部无用例，恰好就是 `sync.ts` 66% 覆盖率缺的那三分之一，也正是数据一致性最危险的区域。测试隔离基本可靠（`fake-indexeddb` + 每用例 `resetDb`，只有 `db.conflicts` 漏清），时间依赖有两处真实时钟绕行（`setTimeout(2)`、手改 `startedAt`），属已知的偶发红来源。E2E 层面：进入 CI 的 4 个脚本都正确设置了 `yh-sync-disabled=1`（红线合规），但 `e2e-merge.py` 因 v1 UI 已删除而**实际不可运行**、`e2e-sync.py` 对生产账本没有护栏、断言值全部硬编码自 `seed.ts`，可维护性与安全性都有真实风险。文档侧的「11 文件 / 90 用例」经核对**属实**，但基线第十五节声称已覆盖的「`bestEffortSnapshot` 失败不阻断主流程」在 `tests/` 中**查无此用例**（全仓无 `spyOn` / 无 `console.warn` 断言），属记录与实现不符，建议一并回写基线。

## 四、按性价比排序的补测清单（最多 5 条）

| # | 补什么 | 为什么排这个位置 | 预估成本 |
|---|---|---|---|
| 1 | **同步入站四条路径**：H1 删除级联、H2 冲突落库、H3 pending 跳过、M1 推送失败保留 | 唯一"既缺测试又可能真有 bug"的区域；全部落在 `sync.ts` 已有的假 `fetch` 脚手架里，可直接照 `tests/sync-unknown-kind.test.ts` 复制，不需要任何新依赖 | 4 个用例，约 120 行 |
| 2 | **M2 降级重试 + M3 离线分支 + M4 disabled 开关** | 每条只需 3–5 行断言就能锁死的契约，M4 还是红线开关本身；做完预计把 `sync.ts` 覆盖率从 66% 拉到 80%+，同时解决两个模块级标志的串扰 | 3 个用例 + 1 个 `__resetSyncFlagsForTest()`，约 60 行 |
| 3 | **M6 + M5**：`clearAllData` 补 conflicts/outbox 顺序断言、`resetDb` 补 `conflicts.clear()` | 现有断言里有两条是恒真的（`Array.isArray` / `order.id` truthy），属于"看起来绿其实没测"；顺便让第 1 条补的冲突用例不会互相串扰 | 2 处改动，约 15 行 |
| 4 | **M7 + M8**：`expiryWarnings` 正例、金额/数量边界与半入方向 | `expiryWarnings` 是库存页唯一"要不要提醒老板"的判断却只测了空集；金额边界则是本项目所有数字的来源 | 3 个用例，约 45 行 |
| 5 | **H4 修 `e2e-merge.py`（或删掉文档条目）+ L6 给 `e2e-sync.py` 加生产账本护栏** | H4 是"文档写着能跑、实际跑不了"的信任问题；L6 是唯一可能真删账本的操作，护栏只有 2 行代码 | 约 60 行改动 |

> **不建议做**：引入 jsdom / Testing Library 去补 UI 组件测试（M10 / M11 只做"纯函数 + `include` 通配"这一小步即可），以及为 `tests/repo.test.ts` 的既有夹具做大规模重构 —— 按基线第十一节第 3 条与第十节「建议到此为止」的判断，这两块收益低于成本。

---

## 五、条目统计

| 级别 | 条目 | 编号 |
|---|---:|---|
| High | 4 | H1、H2、H3、H4 |
| Medium | 12 | M1–M12 |
| Low | 11 | L1–L11 |
| **合计** | **27** | — |