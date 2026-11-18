# 首屏性能优化（2026-11-18）

> 范围：首屏启动链（IndexedDB 读取 → React 首帧）与慢网下的页面切换。
> 数据层接口优化见 [`performance-20261118.md`](performance-20261118.md)，两者不重叠。
> 测量基线：`29e71b2`（本文件改动前）；测量日期 2026-11-18。

## 1. 目标

项目是断网可用的自用 PWA（两台手机、摊位现场开单），首屏在慢网 + 低端机上的可交互时间直接决定「摆好摊能不能马上开单」。

本次不改业务口径、不改页面结构与交互，只处理可测量且可归因的启动成本。

## 2. 测量方法（可复现）

脚本：`.perf/cwv.py`（本地分析目录，已被 `.gitignore` 排除）。

| 项 | 设定 |
|---|---|
| 视口 | 412×915、DPR 2、移动端触摸 |
| 网络 | 1.6 Mbps 下行 / 750 kbps 上行、150 ms RTT（Slow 4G） |
| CPU | 4× 降频 |
| 缓存 | 每轮新 context，Service Worker 停用 |
| 数据 | 内置示例数据；写入被隔离（`localStorage['yh-sync-disabled']='1'`） |
| 采样 | 每版 5 轮，取中位数；前后两版都用 `vite preview` 服务生产构建 |

指标：FCP、LCP、CLS、TBT（长任务超过 50ms 的阻塞部分之和）、INP、首屏可交互（`.glass-tab-bar` 出现）、点击底部 tab 到目标文案出现。

## 3. 基线

| 指标 | 基线 |
|---|---:|
| FCP / LCP | 1404 ms |
| CLS | 0 |
| TBT | 218 ms（单轮 81–324 ms，抖动大） |
| INP | 80 ms |
| 首屏可交互 | 1513 ms |
| 首屏 JS 传输（gzip） | 162.1 KB |

三项 Core Web Vitals 本身已是 Good；真正的问题是启动期的长任务抖动与慢网下的首次页面切换。

## 4. 证据链

用生产 sourcemap 把 CPU profile 采样映射回源码（`.perf/resolve-profile.mjs`）：

| self time（4× CPU） | 来源 |
|---:|---|
| 179.7 ms | Dexie（首屏最大单模块） |
| 95.3 ms | react-dom |
| 5.5 ms | 应用自身代码 |

据此定位到三处与业务无关的启动成本：

1. `snapshotBeforeOpen()` 每次启动把 7 张表整库读进 JS，只为判断「要不要迁移/要不要留快照」；
2. `migrateSessions()` 每次启动 `orders.toArray()` 全表读，只为找缺 `sessionId` 的单；
3. 页面预取用 `requestIdleCallback(timeout 2500)`，在 4× CPU 下常被首屏长任务推迟到 1.8s 之后，用户第一次点 tab 时才开始下载 chunk。

## 5. 已实施改动

| 文件 | 改动 |
|---|---|
| `src/db/backup.ts` | 启动快路径：版本未变 + 已有迁移标记时只读 `settings`，再用 `sessionId` 索引 `count` 判断有无待迁移单；命中则不读业务表。旧库、升级、有待迁移单仍走原完整快照路径 |
| `src/db/repo.ts` | `migrateSessions()` 同源快路径：标记已写时用索引 `count` 替代 `orders.toArray()`；无索引旧库自动回退全表路径 |
| `src/ui/AppShell.tsx` | 预取拆两批：进货 + 开单编辑器在首屏提交后的第一个宏任务开始（约 11 KB gzip），其余页面空闲再取；`saveData` 模式不预取 |
| `vite.config.ts` | Dexie 改指现代 ES 构建（`dexie/dist/modern/dexie.min.mjs`），跳过 ES5 降级包 |

## 6. 优化前后（同条件，5 轮中位数）

| 指标 | 优化前 | 优化后 | 变化 |
|---|---:|---:|---:|
| FCP | 1404 ms | 1332 ms | -5.1% |
| LCP | 1404 ms | 1332 ms | -5.1% |
| CLS | 0 | 0 | 持平 |
| **TBT** | **218 ms** | **113 ms** | **-48.2%** |
| 首屏可交互 | 1513 ms | 1408 ms | -7.0% |
| INP | 80 ms | 64 ms | -20.0% |
| 首屏 JS 传输（gzip） | 162.1 KB | 159.6 KB | -1.5% |
| 首屏主包 | 373.8 KB / 121.4 KB(gzip) | 360.5 KB / 118.8 KB(gzip) | -13.3 KB / -2.5 KB |
| 点「进货」→ 内容可见 | 972 ms | 918 ms | -5.5%（最好一次 440 ms） |
| 点「记账」→ 内容可见 | 120 ms | 87 ms | -27.8% |

稳定性：TBT 从 81–324 ms 的抖动收敛到 104–130 ms。

## 7. 功能与回归验证

| 门禁 | 结果 |
|---|---|
| `pnpm build` | 通过 |
| `pnpm test` | 145/145 通过（改动前的用例集；合并后全量为 336/336） |
| `pnpm perf` | 通过，数据层基线无退化 |
| `python scripts/e2e-smoke.py` | 开单 / 进货 / 库存 / 报表 / 商品 / 设置全流程通过 |
| `python scripts/e2e-offline.py` | Service Worker 预缓存、断网硬刷新、断网开单通过 |
| `python scripts/a11y-check.py` | 0 回归 |

## 8. 剩余瓶颈与权衡

1. 「点进货」的改善不稳定：chunk 请求确实从 1.66–1.94s 提前到 1.63–1.75s，但 4× CPU 下 React 渲染占比更大；继续降低需要减少该页 DOM/组件量，属功能级改动。
2. Dexie 现代构建只省 2.5 KB gzip（Rollup 把 ES5 包也压得差不多），保留它是为了少解析 13 KB ES5 代码；若需支持很老的 WebView，回滚这一条即可。
3. 启动快路径省掉的是 IndexedDB 事务往返，数据涨到几千单时会进一步放大（省掉整表结构化克隆）。
4. 仍保留的架构成本：任何写入都会触发 `useLiveQuery(loadAll)` 重读 7 张表（M-001），要动需拆订阅范围，属产品级改动。

## 9. 回归守护建议

- 首屏预算：Slow 4G + 4× CPU 下 **TBT ≤ 150 ms、首屏可交互 ≤ 1.5 s、JS gzip ≤ 165 KB**；
- 每日/每次发布前用 `.perf/cwv.py` 或 Lighthouse 移动端跑 3–5 轮取中位，超出预算即视为回归；
- 启动链新增 `await` 前先确认是否必须阻塞首帧；能在渲染后空闲做的不要放在 `useBoot` 里。