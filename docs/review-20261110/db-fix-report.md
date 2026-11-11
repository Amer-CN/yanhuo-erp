# DB 层 6 项 P0 修复 · 自检报告（2026-11-10）

自检对象：`src/db/sync.ts`、`src/db/repo.ts`、`src/db/outbox.ts`、`scripts/e2e-sync.py`
自检方式：① 跑门禁命令；② 逐项 `grep`/读源码核对当前工作区（不凭记忆）；③ 用**临时** vitest 脚本验证行为，验证文件已删除、未提交。

> 说明：`src/db/repo.ts`、`src/db/sync.ts` 工作区里还包含**上一轮未提交**的改动（批次快照重算 `refreshClosedSummariesAfterBatchChange` / 清空标记行 `__ledger_cleared__`），因此 `git diff` 的总行数大于本轮 6 项修复自身。

---

## 一、门禁结果（真实输出）

### 1. `pnpm exec tsc --noEmit`

```
$ pnpm exec tsc --noEmit
（无任何输出）
=== exit=0 ===
```

**错误总数：0。**

### 2. `pnpm test`

```
$ vitest run

✓ tests/session.test.ts        (12 tests)   10ms
✓ tests/calc.test.ts            (9 tests)   10ms
✓ tests/outbox.test.ts          (4 tests)   56ms
✓ tests/session-migrate.test.ts (4 tests)  188ms
✓ tests/backup.test.ts          (4 tests)  215ms
✓ tests/clear-cloud.test.ts     (3 tests)   11ms
✓ tests/merge.test.ts           (7 tests)  180ms
✓ tests/sync-unknown-kind.test.ts (2 tests) 91ms
✓ tests/sync-cursor.test.ts     (9 tests)  103ms
✓ tests/repo.test.ts           (21 tests)  426ms
✓ tests/sync-resolve.test.ts   (15 tests)    7ms

Test Files  11 passed (11)
     Tests  90 passed (90)
  Duration  1.96s
```

**通过 90 / 失败 0，失败用例名：无。** 未修改任何 `tests/**` 文件，既有断言全部原样通过（包括 `tests/sync-cursor.test.ts` 对 `buildPullParams` 的 9 条精确断言）。

---

## 二、逐项核对

| # | 项 | 结论 |
|---|---|---|
| ① | 墓碑删除 `SKIP_SETTINGS` 守卫 | ✅ |
| ② | `OVERLAP_MS` 5 分钟重叠窗口 | ✅（实现位置与指令字面不同，见 2.2 说明） |
| ③ | `keep-local`/`conflict` 回推 + 30s 节流 + 防回声 | ✅ |
| ④ | outbox 入队并入业务事务 | ✅（21 处；未改项见 2.4） |
| ⑤ | `parseRemoteRecord` 入站校验 + 跳过 + 诊断上限 20 | ✅ |
| ⑥ | `e2e-sync.py` 生产账本护栏 + 头注释 | ✅ |

### 2.1 ① 墓碑删除白名单

`src/db/sync.ts:784-795`（`planRemoteChanges()` 内）：

```ts
for (const row of knownRows) {
  if (row.deleted) {
    // 设备级设置永不同步删除：远端墓碑（旧版本 bug / 控制台误操作 / 持码者写入）
    // 删掉本机 deviceId 会让 ensureDeviceId 重新生成 UUID，正在进行中的场次立刻「找不到」，
    // getLastSession 也看不到原场次；deviceName / sync-unknown-kinds 同理只属于本机。
    if (row.kind === 'setting' && SKIP_SETTINGS.has(row.record_id)) continue;   // ← 新增守卫 :790
    if (row.kind === 'order') dropLinesOfOrder(row.record_id);
    deleteRow(row.kind, row.record_id);
    continue;
  }
```

`SKIP_SETTINGS` 定义在 `src/db/sync.ts:58`：`new Set(['deviceId', 'deviceName', 'sync-unknown-kinds'])`；put 分支的对称守卫在 `:839`（`if (SKIP_SETTINGS.has(row.record_id)) break;`）。

**行为验证**（临时用例）：远端同时下发 `setting:deviceId` / `setting:deviceName` / `setting:operatorA` 三条墓碑 → 前两条本地值保留，`operatorA` 被删。✅

### 2.2 ② 5 分钟重叠窗口

常量 `src/db/sync.ts:74-92`（含完整中文注释）:

```ts
const OVERLAP_MS = 5 * 60 * 1000;   // :92
```

起点计算 `src/db/sync.ts:1003-1006`：

```ts
export function pullStartCursor(cursor: PullCursor): PullCursor {
  if (cursor.ts <= 0) return cursor;                        // 首次/全量重放：起点仍 0，不变负数
  return { ts: Math.max(0, cursor.ts - OVERLAP_MS), id: '' };
}
```

游标推进未被污染 `src/db/sync.ts:1087-1119`：

```ts
const start = await resolvePullStart(cfg);
let cursor = start;                      // 持久化游标：只按真实行尾推进
let requestCursor = pullStartCursor(start);   // 请求游标：仅首轮回退

for (let page = 0; page < MAX_PAGES; page++) {
  const rows = await fetchRemotePage(cfg, requestCursor);
  ...
  cursor = nextCursor(rows, cursor);     // :1113 真实推进
  setLastPullCursor(cursor);             // :1114 只写真实游标
  requestCursor = cursor;                // :1116 后续页不再回退
```

**⚠️ 与指令字面的一处偏差（如实记录）**：5 分钟回退**没有写进 `buildPullParams`**（`:970-990` 保持原样，仍是「`ts=0` 不加条件 / `id=''` 用 `gte` / 否则 `(ts,id)` 严格比较」）。原因有两条，都是硬约束：

1. `buildPullParams` 是**每页**都调用的；若在它内部减 5 分钟，第 2 页起会把起点再退回去。对「水位 < 5 分钟」的年轻账本会退化成每页都从 0 开始 → 20 页内反复拉同一段、游标永不推进；
2. `tests/sync-cursor.test.ts` 有 4 条断言精确匹配 `buildPullParams` 的 `gte`/`or` 字符串（例如 `gte.1700000000123`），改它必然要求改测试，而 `tests/**` 不在本次可改范围。

因此把「回退」放在 `pullStartCursor()` 里、只作用于本轮第一页，**语义与要求完全一致**（首轮起点回退 5 分钟、`cursor=0` 时仍为 0、`setLastPullCursor` 只收真实游标）。若要求必须物理落在 `buildPullParams` 内，可增加可选参数 `overlapMs`（默认 0，`pull` 首轮传 `OVERLAP_MS`），但同一批 4 条断言仍需测试侧更新。

**行为验证**（临时用例）：持久化游标 `10000000` → 首个请求带 `updated_at=gte.9700000`（无 `or`）；本轮结束 `yh-sync-last-pull` 仍为 `10000000`；`pullStartCursor({ts:100000}) → {ts:0}`、`{ts:0} → {ts:0}`。✅

### 2.3 ③ keep-local / conflict 回推 + 30s 节流 + 防回声

判定与登记候选 `src/db/sync.ts:808-822`：

```ts
if (decision === 'keep-local' || decision === 'conflict') {
  if (decision === 'conflict') { conflictRows.push({ ... }); }
  // 只有内容真的不同才回推：远端如果只是本机自己刚推上去的那一版（时间相同、内容相同），
  // 回推就变成无意义的写放大，还会让两台设备互相喂数据。
  if (!sameContentAsRemote(cur, row.data, row.record_id)) {
    plan.repush.push({ kind: row.kind, id: row.record_id });
  }
  continue;
}
```

节流常量 `:97-101`：`REPUSH_THROTTLE_MS = 30_000`、`REPUSH_PRUNE_AT = 500`；节流表 `:669`：`const lastRepushAt = new Map<string, number>()`。

入队实现 `src/db/sync.ts:713-734`（best-effort）：

```ts
const key = `${c.kind}:${c.id}`;
if (now - (lastRepushAt.get(key) ?? 0) < REPUSH_THROTTLE_MS) continue;   // :721
lastRepushAt.set(key, now);
...
try { await enqueueMany(rows); }
catch (e) { console.warn('[sync] 回推本地较新版本失败，下一轮同步会重新判定', e); }   // :732-733
```

调用点在事务**外**（`src/db/sync.ts:926`）：`await repushLocalVersions(plan.repush);`（事务只负责落库，回推失败不回滚已应用的远端行）。

防回声比较 `:675-691`：`canonicalJson()` 键排序序列化 + `sameContentAsRemote()` 补上 `id` 后比较，避免键顺序差异误判。

**行为验证**（临时用例，3 条）：远端=本机回声（时间相同、内容相同）→ `outbox` 不新增；远端=对方旧版本（内容不同）→ 本地值保留且 `outbox.get('order:o1')` 存在；键顺序不同但内容相同 → 同样不回推。✅

### 2.4 ④ outbox 入队并入业务事务

公共实现 `src/db/repo.ts:43-52`：

```ts
async function writeWithOutbox(
  tables: Table[],
  write: () => Promise<void>,
  items: OutboxItem[]
): Promise<void> {
  await db.transaction('rw', [...tables, db.outbox], async () => {
    await write();
    await enqueueInTx(items);      // 同事务：入队失败连业务写入一起回滚
  });
  syncWanted();                    // 提交后才通知同步
}
```

`src/db/outbox.ts:66-69` 的 `enqueueInTx()` 只做 `db.outbox.bulkPut(buildRows(rows))`，不 dispatch、不重试；`enqueue` / `enqueueMany` 对外签名保持不变（`:36-49`）。

**实际改造 21 处**（`writeWithOutbox(` 调用行号，`src/db/repo.ts`）：

| 函数 | 行号 | 事务表 |
|---|---|---|
| `setSetting` | 62 | settings |
| `ensureBootstrapSettings` | 100 | settings |
| `createProduct` | 136 | products |
| `updateProduct` | 159 | products |
| `deleteProduct` | 178 | products |
| `createBatch` | 227 | batches |
| `deleteBatch` | 266 | batches |
| `ensureOpenSession` | 331 | sessions |
| `saveRecord` | 509 | orders + lines |
| `updateRecord` | 545 | orders + lines |
| `deleteRecord` | 570 | orders + lines |
| `undoPatchedRecord` | 603 | sessions + orders + lines |
| `closeSession` | 637 | sessions |
| `reopenSession` | 662 | sessions |
| `addPatchedRecord` | 705 | sessions + orders + lines |
| `refreshSessionSummary` | 731 | sessions |
| `writeClosedSummaries` | 761 | sessions |
| `migrateSessions` | 885 | sessions + orders + settings |
| `voidOrder` | 913 | orders |
| `restoreOrder` | 929 | orders |
| `createAdjustment` | 956 | adjustments |

指令列出的 12 处全部覆盖；额外把同模式的 9 处（`updateProduct` / `deleteProduct` / `ensureBootstrapSettings` / `reopenSession` / `refreshSessionSummary` / `writeClosedSummaries` / `migrateSessions` / `voidOrder` / `restoreOrder`）一并收敛，避免同一文件里两种写入语义并存。

**`repo.ts` 内已无裸 `enqueue(` / `enqueueMany(`**（`Select-String` 结果为空）；全仓 `db.outbox` 写入只剩 `outbox.ts` 三处（`:42` `enqueue`、`:48` `enqueueMany`、`:66` `enqueueInTx`）。

**`clearAllData` 契约未破**（`src/db/repo.ts:978-1002`）：`db.conflicts.clear()` 仍在事务内，`await db.outbox.clear()`（`:1001`）仍是函数最后一句，位于两次 `setSetting` 之后。

**未改的点及原因**：

| 位置 | 为什么不动 |
|---|---|
| `src/db/outbox.ts` 的 `enqueue` / `enqueueMany` | 对外 API 必须保持（`sync.ts` 回推、`enqueueAllLocal` 在用）；只是抽出 `buildRows()` 复用 |
| `src/db/merge.ts` 全部写入 | 导入/合并后统一由 `afterMerge()` → `markAllDirty()` → `enqueueAllLocal()` 全量重推，逐条入队属重复 |
| `src/db/seed.ts:52-56`（种子示例商品 + `seeded` 设置） | 首次启动写示例数据，既有行为不入队；改它会把示例商品推到云端（超出本次 6 项范围，属产品决策） |
| `clearAllData()` 的 `db.outbox.clear()` | 必须最后执行，保持原样 |

**行为验证**（临时用例，3 条，mock `db.outbox.bulkPut` 抛 `quota exceeded`）：写一单 → `orders=1/ lines=1/ outbox=[order:x, line:y]`；入队失败 → `orders=0/ lines=0/ outbox=0`（真回滚）；`setSetting` 入队失败 → 设置值也回滚。✅

### 2.5 ⑤ 远端 data 校验层

- 诊断上限常量：`src/db/sync.ts:75` `const INVALID_REMOTE_KEEP = 20;`
- 写诊断：`src/db/sync.ts:214-225`

```ts
function warnInvalidRemote(kind: string, recordId: string): void {
  try {
    const line = `拉取到非法数据已跳过：${kind}:${recordId}`;
    const prev = localStorage.getItem(LS.warn) ?? '';
    const items = prev ? prev.split('\n') : [];
    if (items.includes(line)) return;
    items.push(line);
    localStorage.setItem(LS.warn, items.slice(-INVALID_REMOTE_KEEP).join('\n'));   // 最多 20 条
  } catch { /* 隐私模式忽略 */ }
}
```

- 校验表与函数：`REMOTE_SCHEMAS`（`:505`）、`withinBounds`（`:603`）、`parseRemoteRecord`（`:631-659`）

```ts
export function parseRemoteRecord(kind: Kind, data: unknown): Record<string, unknown> | null {
  if (!isPlainObject(data)) return null;                 // null/数组/字符串 一律非法
  const schema = REMOTE_SCHEMAS[kind];
  if (!schema) return null;
  for (const [field, type] of Object.entries(schema.required)) {
    if (!matchFieldType(data[field], type)) return null; // num 需 Number.isFinite
  }
  ...
  return withinBounds(kind, data) ? data : null;
}
```

- 落库分支接上校验（`src/db/sync.ts:824-859`）：`session` / `setting` / default 三个分支均在 `!parsed` 时 `warnInvalidRemote(...)` 后 `break`，不 `bulkPut`；`deleted` 分支不校验（墓碑只有 id 语义）。
- 辅助实现：`matchFieldType`（`:578`）、`isPlainObject`（`:594`）、`ENUM_FIELDS`（`:570`，`payMethod/unit/status/type/category` 值域）。

**行为验证**（临时用例，2 条）：`totalFen:'abc'` 与 `data:'not-an-object'` 均未落库、诊断含 `order:bad` / `order:nan`（2 行）、同页合法行正常写入；一次 25 条脏行 → 诊断截断为 20 条且最后一条为 `order:bad24`。✅

### 2.6 ⑥ e2e 生产账本护栏

`scripts/e2e-sync.py`：

- `:8-11` 头注释：「⚠️ 本脚本是**全仓唯一不设 `yh-sync-disabled=1` 的脚本**…真实模式必须使用**测试专用账本**…若 `SYNC_LEDGER` 等于内置生产账本码（`src/db/syncDefaults.ts`），脚本会直接退出。」
- `:41` `SYNC_DEFAULTS = os.path.join(ROOT, "src", "db", "syncDefaults.ts")`
- `:46-55` `builtin_ledger_key()`：正则 `ledgerKey:\s*'([^']+)'` 从源码读取，避免硬编码漂移
- `:57-66` `guard_production_ledger()`：

```python
def guard_production_ledger() -> None:
    """真实模式下拒绝用内置生产账本：cleanup_cloud() 会把整本账软删。"""
    if USE_MOCK:
        return
    prod = builtin_ledger_key()
    if prod and REAL_LEDGER == prod:
        sys.exit(
            "拒绝用生产账本跑 E2E：SYNC_LEDGER 等于内置生产账本码，"
            "cleanup_cloud() 会把真账本整体软删。请改用测试专用账本。"
        )
```

- `:192-194` `main()` 第一行即调用：

```python
def main() -> int:
    # 第一行护栏：真实模式下绝不允许对着内置生产账本跑（cleanup_cloud 会整体软删）
    guard_production_ledger()
```

**行为验证**：`SYNC_LEDGER=beddbf7e285340e3bda1e6319ddaf3ce2dc9d0d652eb42ff`（内置生产码）→ `exit=1`，输出「拒绝用生产账本跑 E2E…」；`python -m py_compile scripts/e2e-sync.py` 通过；`USE_MOCK`（不设 `SYNC_*`）时护栏直接 return，默认假 Supabase 流程不受影响。✅

---

## 三、本轮自检用到的临时脚本（已删除，未提交）

| 临时文件 | 用例数 | 覆盖点 | 结果 |
|---|---|---|---|
| `tmp-verify/outbox-tx.test.ts` | 3 | 入队同事务；入队失败全回滚；`setSetting` 回滚 | 3 passed |
| `tmp-verify/sync-fixes.test.ts` | 6 | 墓碑白名单；重叠窗口起点；游标不被污染；回推+节流；脏行跳过+诊断截断 | 6 passed |
| `tmp-verify/repush.test.ts` | 3 | 回声不回推；内容不同才回推；键顺序不同不回推 | 3 passed |

运行方式：临时 `vitest.tmp.config.ts`（`include: ['tmp-verify/**/*.test.ts']`）。跑完已连同配置与 `scripts/__pycache__` 一起删除；`git status` 中不含这些文件。

---

## 四、遗留 / 需他人接手

1. **`docs/代码异味基线-20261110.md` 未回写**：AGENTS.md 要求改结构后回写「已消除」，但本轮可改范围只含 `src/db/**`、`scripts/e2e-sync.py` 与本报告，基线文档留给你或测试批次补。建议条目：M-5 / H-1（过渡方案）/ M-2 / M-1 / M-6 / testing-L6，并记录「H-1 根治仍需 `updated_at` 交服务端生成（未改 `supabase/schema.sql`）」。
2. **`docs/03-云同步设置.md` 键清单无需新增**：非法行诊断复用既有 `yh-sync-warn`（换行分隔、上限 20 条），仅展示语义从单条变为可能多行，建议在文档补一句说明。
3. **测试补充建议**（`tests/**` 不在本次范围）：墓碑白名单、`pullStartCursor`、回推节流与防回声、`parseRemoteRecord` 表驱动、`e2e-sync.py` 护栏（可对 `guard_production_ledger()` 做纯函数级验证）。

---

## 五、回滚方式

| 项 | 回滚 |
|---|---|
| ① | 删除 `src/db/sync.ts:790` 那一行守卫 |
| ② | `let requestCursor = pullStartCursor(start);` → `= start;`（或 `OVERLAP_MS = 0`） |
| ③ | 删除 `src/db/sync.ts:926` 的 `repushLocalVersions(...)` 调用（其余逻辑不受影响） |
| ④ | 单文件 revert `src/db/repo.ts`；`outbox.ts` 的 `enqueueInTx` 留着不用也无副作用 |
| ⑤ | default 分支改回 `putRow(row.kind, row.record_id, { ...(row.data as Record<string, unknown>), id: row.record_id })` |
| ⑥ | 删除 `scripts/e2e-sync.py:194` 的 `guard_production_ledger()` 调用 |