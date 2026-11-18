# 数据层接口性能优化（2026-11-18）

> 范围：本项目是纯前端 PWA，"接口"指 **`src/db/` 数据层对外函数**（`loadAll` / `saveRecord` /
> `sessionReport` / `fifoAllocate` / `syncNow` 等）与页面消费它们的派生计算路径。
> 不含 CSS/首屏 LCP 优化（那部分已有基线：LCP 1232ms / CLS 0 / TBT 91ms）。

## 1. 目标与工作负载

| 项 | 设定 |
|---|---|
| 场景 | 摊位一季账本：200 商品 / 400 批次 / **3000 单** / **6000 明细** / 40 场次 / 200 库存调整 |
| 目标 | 降低「写入后数据刷新」与「报表整页汇总」的主线程耗时，且不改任何业务口径 |
| 验收 | 同负载前后对比 + 145 条功能用例 + 逐字段一致性断言 |

## 2. 基线方法（可复现）

```bash
pnpm perf     # vitest run --config vitest.perf.config.ts
```

- 文件：`tests/perf/baseline.perf.ts`（独立配置，不进 `pnpm test`）
- 环境：Node 24 / fake-indexeddb 6 / 同一进程内采样，报告 **p50 与 p95**（不用平均值）
- 每个指标 warmup 1 次后采样 5–30 次
- 关键对照**同进程 A/B 交替**：`fifoAllocate` 的优化前实现保留在 `tests/perf/calc-legacy.ts`，
  新旧实现交替采样，排除机器漂移；同时逐值比对 `lineCost` / `batchRemaining` / `uncovered*`

> 注：fake-indexeddb 是纯 JS 实现，绝对耗时高于真实 Chromium 的 IndexedDB。
> 因此**只把它用于同环境前后对比**，不把绝对值当作真机指标。

## 3. 瓶颈定位（按实测贡献排序）

| 观测 | 基线 p50 | 结论 |
|---|---|---|
| `loadAll()` 全表 7 张表 | 44.7–56 ms | **主导成本**，几乎全部是 IndexedDB 反序列化 6600 行；`App.tsx` 的 `useLiveQuery(loadAll)` 在任何表写入后都会重跑（M-001） |
| `refreshSessionSummary()` | 39.9–78 ms | = `loadAll` 同量级读数 + `fifoAllocate` + 写回；结账/补记/作废路径 |
| `sessionReport × 40 场` | 6.6–11.6 ms | **O(场次 × 明细)**：每场都 `orders.filter` + `lines.filter` 扫全库；且报表页在渲染体内调用，父组件每次重渲染都重跑（M-006） |
| `fifoAllocate()` | 4.0–7.1 ms | 排序比较函数里现拼 `receivedAt\|createdAt\|id`（400 批次 ≈ 7000 次字符串分配）；明细排序每次比较查两次 Map |
| `saveConflicts()`（同步一页冲突） | 10.9–24.7 ms / 40 条 | 逐条 `where().first()` + `put()/add()`，2N 次串行 IDB 往返 |
| `saveRecord()` / `updateRecord()` | 0.8 / 1.0–1.5 ms | 不是瓶颈，保持不变 |

被验证后**否决**的候选：

1. `loadAll` 改单只读事务：p50 38.5 / p95 56.3 vs 44.7 / 55.3 —— 无稳定收益，反而 p95 略差。
   成本在反序列化，不在事务数。
2. `updateRecord` 复用明细 id 以减少 outbox（M-008）：会改变 FIFO 同一时间片内按 `line.id`
   的 tie-break，存在改写历史成本的风险，收益仅是云端写放大；按「正确性优先」不改。

## 4. 已实施优化

### 4.1 `calc.sessionReports()`：场次汇总从 O(场次×明细) 降到 O(场次+明细)

- 新增批量接口（`src/db/calc.ts`）：一次遍历 `orders` 建「有效单 → 场次」索引并累计收款，
  一次遍历 `lines` 累计成本/让利/赠品/缺批次销量，再一次遍历 `orders` 统计作废单。
- `ReportPage`：历史场次列表的 `closed.map(...)` 渲染体调用改为 `useMemo` + 批量结果
  （`historySummaries`），并保留单场 `sessionReport` 给「本场汇总」。
- `dayReport`：同样改为一次批量，不再逐场扫全库。
- 兼容性：`sessionReport` 单场接口签名与行为不变；新增的 5 条测试逐字段断言
  `sessionReports(id) === sessionReport(id)`（覆盖作废单、赠品、超卖缺批次）。

### 4.2 `fifoAllocate()`：排序键预算

- 批次排序键按对象引用缓存一次（仍是 `batchOrderKey` 唯一口径）；
- 明细排序预装饰 `{ line, at }`，比较函数不再查 Map。
- 结果与优化前实现**逐值一致**（基准内置断言 `fifoResultIdentical: true`）。

### 4.3 `sync.saveConflicts()`：冲突留痕批量落库

- 单事务 + `[kind+recordId]` 复合索引 `anyOf` 一次取已有行 + 一次 `bulkPut`；
- 批内同键先合并（后者覆盖前者），保持「一条记录只占一行」的去重口径（H2.2 不回退）。

## 5. 优化前后对比（同一负载、同进程 A/B）

| 指标 | 优化前 p50 | 优化后 p50 | 变化 | p95 变化 |
|---|---:|---:|---:|---:|
| 40 场次汇总（报表整页） | 6.6 ms | **1.5 ms** | **-77%** | 9.2 → 1.6 ms（-83%） |
| `fifoAllocate()` | 4.0 ms | **3.0 ms** | **-25%** | 5.2 → 4.1 ms（-21%） |
| `saveConflicts()` 40 条 | 10.9 ms | **3.2 ms** | **-71%** | — |
| `loadAll()` | 44.7 ms | 44.7 ms | 0%（见第 3 节否决项） | 55.3 → 55.3 ms |
| `saveRecord()` | 0.8 ms | 0.8 ms | 0%（未改） | 1.2 → 1.2 ms |

> 上表取同一轮 A/B 采样的 p50。另做 4 轮重复测量，结论稳定：
> 40 场汇总 6.6–11.6 → **1.4–2.0 ms**；`fifoAllocate` 4.0–5.4 → **3.0–3.7 ms**；
> `saveConflicts` 10.9–24.7 → **2.9–5.1 ms**。`loadAll` 单事务与逐表并发在各轮互有胜负，无一致收益。

派生效果：

- 报表页每次重渲染（点场次、开 Sheet）不再重算 40 场汇总，只算一次；
  该页的汇总耗时从 6.6ms 级降到 1.5ms 级，且与「打开哪一场」解耦。
- 结账/补记路径中的 `refreshSessionSummary` 里 FIFO 部分同步下降约 25%；
  其剩余成本与 `loadAll` 同源（全表读数），属于 M-001 的架构成本。
- 同步冲突较多的一页（40 条）从 ~11ms 降到 ~3ms，且不再随冲突数线性放大 IDB 往返。

## 6. 功能正确性验证

| 门禁 | 结果 |
|---|---|
| `pnpm test` | 14 文件 / **145 用例全部通过**（新增 5 条批次/单场一致性断言） |
| `pnpm build` | 通过（tsc --noEmit + vite build） |
| `pnpm lint` | 0 error（35 条既有 warning，与本批无关） |
| 数据口径 | `fifoAllocate` 新旧实现逐值一致；`sessionReports` 与 `sessionReport` 逐字段一致 |

## 7. 剩余瓶颈与后续方向

1. **M-001（保留）**：任何写入都会让 `useLiveQuery(loadAll)` 重读全部 7 张表。
   接口层已无低成本空间；若要继续降，只能拆订阅范围（例如历史订单/明细按场次懒加载），
   属产品级改动，需单独评审冷启动与离线一致性。
2. `refreshSessionSummary` / `closeSession` 必须全库重放 FIFO，这是成本准确性的前提；
   `writeClosedSummaries` 已经做到「一次 FIFO 供多场复用」，单场接口仍无法裁剪。
3. 报表页 DOM 数量（历史全部场次）与流水页一次性渲染全部订单，属渲染层问题，
   不在本次接口优化范围（已有建议：时间范围过滤优先于虚拟列表）。