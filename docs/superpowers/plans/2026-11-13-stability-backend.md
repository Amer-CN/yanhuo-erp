# 数据、同步与云端协议修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 阻止同步吞写、跨页丢明细、部分撤销、恢复队列污染和跨账本碰撞；为全云清空提供事务和幂等保证。

**Architecture:** 不替换本地优先模型。网络在事务外，IDB 快照/应用/确认各用短事务；outbox 使用唯一修订标识；暂未找到父单的明细进入持久待决区；恢复与同步共享控制门；全单撤销带完整前后快照与新业务时间。PostgreSQL 通过两阶段约束迁移实现 `(ledger,id)` 唯一，清空由单 RPC 原子执行。

**Tech Stack:** TypeScript、Dexie、Vitest/fake-indexeddb、Playwright、PostgreSQL RLS/PostgREST。

---

## 文件图与依赖

主索引和发布顺序见 [总方案](2026-11-13-stability-repair.md)；前端操作契约见 [前端计划](2026-11-13-stability-frontend.md)。B02/B03/B04 顺序修改 `sync.ts`；B05/F02/B06 顺序修改设置与同步协调。该拆分是修复责任划分，不借机全面重构。

| 文件 | 职责 |
|---|---|
| `src/db/db.ts` | outbox 修订字段、待决明细/撤销/同步控制表和版本迁移 |
| `src/db/outbox.ts` | 唯一修订、同事务入队、按版本确认 |
| `src/db/sync.ts` | 推拉协调、跨页重试、整单影响收集、RPC 与协议兼容 |
| `src/db/remoteOrderUndo.ts`（新） | 完整订单快照、前后指纹、撤销与入队 |
| `src/db/syncControl.ts`（新） | 同步会话失效、数据操作互斥、持久暂停/重新连接 |
| `src/db/backup.ts` / `merge.ts` / `repo.ts` | 恢复/合并与队列边界，业务/备份保持事务 |
| `src/db/calc.ts` | 只在入站规范化后消费有限数值，保留防御默认值 |
| `src/ui/useSync.ts` | 使用 DB 层协调状态，不再以 hook ref 充当全局互斥 |
| `scripts/mock-supabase.mjs` | 真实约束子集、请求日志、受控延迟/失败；仅 loopback |
| `scripts/e2e-sync-recovery.py`（新） | 多 context 并发/恢复/多账本/清空专项 |
| `supabase/migrations/2026-11-13-stability-prepare.sql`（新） | 补列、复合唯一约束、RPC、操作凭证 |
| `supabase/migrations/2026-11-13-stability-finalize.sql`（新） | 两端升级后的主键切换 |
| `supabase/tests/stability.sql`（新） | 本地测试库的角色/RLS/约束/RPC 验收 |
| `tests/sync-ack.test.ts` 等任务列明测试 | 不依赖临时目录的回归 |

本计划的测试代码片段定义断言核心；fixture 使用仓库现有 `tests/helpers.ts` 的 `makeOrder/makeLine/makeProduct/resetDb`。gate由Promise+resolve在对应测试内创建；cfg/sent/readLedger等测试变量由该文件fixture创建，不能依赖未定义的外部辅助包。新增产品API必须在该任务实现并列出导出。本文不是可整块复制覆盖源码的补丁；实施者须结合实际类型实现，不能把接口声明和示例断言当成已完成代码。

## B01 — 回归基础与假后端契约

**优先级：先行；Files:** 修改 `scripts/e2e-merge.py`、`scripts/mock-supabase.mjs`、`scripts/e2e-sync.py`、`scripts/e2e_util.py`；新建 `tests/mock-supabase.test.ts`、`scripts/e2e-sync-recovery.py` 的安全启动骨架；复用 `tests/helpers.ts`。

- [ ] **1. 固化已实测失败条件。** 将临时 `ACK_RACE`、`ORDER_UNDO`、`FIRST_SYNC_PAGES`、`INBOUND_MISSING_DISCOUNT` 场景分别搬进 B02/B03/B04 的测试文件。先保存坏版本的执行结果；不要将“确认当前 bug 存在”的断言混成修复后的长期断言。长期预期分别为：新 delete 仍 pending、整单恢复、合法 line 最终存在、所有汇总有限数值。
- [ ] **2. 修 e2e-merge 过期回执。**

```python
from e2e_util import wait_for_save_receipt, wait_for_toast
receipt = wait_for_save_receipt(page, '已记 1 单', timeout=10000)
assert receipt is not None and expect_total in receipt
page.wait_for_selector('.glass-sheet', timeout=5000)
page.wait_for_timeout(500)  # 只等待已定义400ms入场锁，非业务完成条件
page.get_by_role('button', name='完成（回单据）', exact=True).click()
```

导出/合并完成仍等待其真实 Toast；新增相同文件二次导入，订单/明细/商品不重复。修改循环注释中30ms旧延迟。生产账本 guard 读取不到内置码时，对真实模式 fail closed；默认不允许用真实模式跑。
- [ ] **3. mock 拒绝不符合 RLS 的整批写。** `POST` 在改 Map 前先验证所有行：header ledger 非空、payload ledger 匹配、现存同 id 他账本不可覆盖。任一非法行整批返回 403，Map 不变；不能边循环边写一半再报错。GET 同时应用 `ledger`/`id=eq`/`record_id=in`/kind/cursor/order/limit 的实现子集，不识别过滤式返回 400 而非放行。DELETE 默认 403，不能假装新版策略允许物理删除。
- [ ] **4. 可控故障。** 把服务器初始化抽成导出 `createMockServer(options)`，默认端口/命令行为不变；测试注入请求 gate、响应失败和请求日志。v1 模式全表 id 唯一，v2 模式按 ledger+id；RPC 由 B06 补。只在初始化参数启用测试控制，不能提供远程无鉴权清空真实服务的路由。

```ts
// tests/mock-supabase.test.ts 核心验收
expect(batchResponse.status).toBe(403);
expect(await readLedger('first')).toEqual(beforeFirst);
expect(await readLedger('second')).toEqual(beforeSecond);
// 同账本upsert、id精确过滤、cursor满页边界仍按已有客户端参数工作。
```

- [ ] **5. 命令。** `pnpm exec vitest run tests/mock-supabase.test.ts`；`python scripts/e2e-merge.py`；`python scripts/e2e-sync.py`（unset SYNC_URL/KEY/LEDGER）。失败要区分 mock 新抓到的产品 bug 和脚本错误，不能弱化 mock 让测试绿。
- [ ] **6. 提交。** `test(sync): enforce mock contracts and restore merge regression`。

## B02 — outbox 修订确认与入站竞态

**优先级：P1；依赖：B01。Files:** 修改 `src/db/db.ts`、`outbox.ts`、`sync.ts`；新建 `tests/sync-ack.test.ts`，补 `tests/outbox.test.ts`。

- [ ] **1. 失败用例：POST gate。** 在 fake fetch 收到第一次 upsert 后扣住 Promise；通过真实业务入口再入队同记录 delete；释放旧 POST。修复后 delete 仍存在、下一轮确实发送 `deleted:true`，云端最终无活单。追加同毫秒多次 upsert、upsert→delete→upsert、POST失败、关闭/重开数据库。

```ts
const first = syncNow(cfg);
await postedGate;
await deleteRecord(order.id);
releaseResponse();
await first;
expect(await db.outbox.get(`order:${order.id}`)).toMatchObject({ op: 'delete' });
await syncNow(cfg);
expect(sent.flat().some(r => r.record_id === order.id && r.deleted)).toBe(true);
```

- [ ] **2. 每次入队生成唯一 revision。** `OutboxRow` 新增 `revision?: string`（兼容 v5 旧行）；`buildRows` 每行 `revision: uuid()`，使用现有 util.uuid。不能用 Date.now 或 queuedAt 代替修订，因为同毫秒可覆盖。revision 不建索引，因此不单独升 DB 版本。
- [ ] **3. 短事务确认，只删自己发过的修订。**

```ts
await postWithSchemaFallback(cfg, payload); // 网络在IDB事务外
await db.transaction('rw', db.outbox, async () => {
  for (const sent of rows) {
    const current = await db.outbox.get(sent.id);
    const same = sent.revision
      ? current?.revision === sent.revision
      : current?.revision === undefined && current?.queuedAt === sent.queuedAt && current?.op === sent.op;
    if (current && same) await db.outbox.delete(sent.id);
  }
});
```

旧无revision行只允许匹配旧格式本身；任何新入队都有revision，不受旧ack影响。读取 outbox 和业务快照要处于同一只读事务；网络不占事务。
- [ ] **4. pending 判断挪进应用事务。** 当前 applyRemoteBatch 在事务外查 pending，可能读到旧队列。将 db.outbox 加入既有应用事务，在同一 rw snapshot 内过滤 pending，再读业务/规划/写入。不可先查pending、跨一次await再开业务事务。新本地写在应用前提交则保留本地；在应用后提交则正常产生新revision。
- [ ] **5. 验收。** `pnpm exec vitest run tests/outbox.test.ts tests/sync-ack.test.ts tests/sync-inbound.test.ts`；`pnpm test:cov`；mock sync/offline。新增至少6类状态断言，无 skip。commit：`fix(sync): acknowledge only sent outbox revisions`。

## B03 — 父子跨页、待决明细与数值规范化

**优先级：P1；依赖：B02。Files:** 修改 `db.ts`、`sync.ts`、`calc.ts`、`tests/helpers.ts`、`tests/sync-inbound.test.ts`、`tests/calc.test.ts`；新增 `tests/sync-parent-pages.test.ts`。

- [ ] **1. 失败用例。** 构造501行：第一页早line+499其他记录，第二页父order晚10分钟。fake fetch 按真实 URL 过滤排序；首轮/第二轮都不能以丢line告终。再测父未上传、父墓碑、父本地pending delete、父在下一天、进程重启和1万行续扫。
- [ ] **2. 待决区，不把“未到”当“已删除”。** Dexie v6 新增 `remotePendingLines: 'id, orderId, receivedAt'`。保持 v5 的conflicts迁移原样，不能把 `this.version(SCHEMA_VERSION)` 原地改成6而丢掉v5定义；固定 version(5)，再增加version(6)。待决行结构：

```ts
export interface RemotePendingLine {
  id: string;             // 本地line id
  orderId: string;
  row: { id: string; record_id: string; kind: 'line'; data: Record<string, unknown>;
    updated_at: number; record_updated_at?: number; deleted: boolean };
  receivedAt: number;
}
```

父单不存在时只持久化到待决表，不放进业务lines，也不丢；游标仅在业务+待决行事务均成功后推进。已有父order墓碑同页删除对应待决行。父活单入库同事务 drain 其待决行；父本地有pending delete时不复活，留待删除完成后按远端权威状态处理。
- [ ] **3. 每轮补查未知父单。** 在网络阶段对最多100个不同父id分批 `kind=eq.order&record_id=in.(...)`，每批最多50，沿用相同ledger头与列降级；结果先走正常order解析/冲突/pending过滤，再drain。显式墓碑可清待决；空响应不是“父已删”，待决保持并提示“明细等待主单同步”。不等待24小时才重试，不把待决表算进用户库存/毛利。超过容量/存储错误要阻止相应页游标提交并报可见诊断，不能静默drop；默认上限10000待决line。
- [ ] **4. 避免假下载完成。** SyncResult 增 `deferredLines:number`、`hasMore:boolean`；初始下载有capped或待决行时继续显示未完整，不宣称“历史已全部同步”。续扫从已经扫到的真实游标开始，不反复对resume扣5分钟；只有普通增量首请求用overlap。每日标记只能表示扫描完成，不代表待决数据完整，UI分别显示。
- [ ] **5. 入站规范化。** `discountFen` 缺失/null按0补齐，数值字段若存在须有限；line qty/单价按已有语义从qtyBase/amountFen派生，gift缺失false；必填无合法来源则拒绝并留诊断，不强行猜。计算链 `discount += l.discountFen ?? 0` 保留防御。不同旧格式实际导出样本先锁用例，不把任意数字字符串强转成可信金额。

```ts
const parsed = parseRemoteRecord('line', { orderId:'o1', productId:'p1', qtyBase:2, amountFen:500 });
expect(parsed).toMatchObject({ discountFen:0, gift:false });
const report = sessionReport('s1', [order], [line], fifoAllocate([], [order], [line]));
expect(Number.isFinite(report.discountFen)).toBe(true);
```

- [ ] **6. 测试。** 当前fixture `resetDb`加清 remotePendingLines；v5→v6升级前后原业务订单/冲突不丢。`pnpm exec vitest run tests/sync-parent-pages.test.ts tests/sync-inbound.test.ts tests/sync-cursor.test.ts tests/calc.test.ts`；mock sync/offline。commit：`fix(sync): defer child rows until parents arrive and normalize amounts`。

## B04 — 完整订单撤销与后续编辑保护

**优先级：P1；依赖：B03。Files:** 新增 `src/db/remoteOrderUndo.ts`、`tests/remote-order-undo.test.ts`；修改 `db.ts`、`sync.ts`、`ui/useSync.ts`、`repo.ts`、`tests/helpers.ts`。

- [ ] **1. 失败用例。** X原¥10/1件，远端¥20/2件、旧line墓碑+新line；撤销后必须恢复原header与1件line，同时新line被删除并入队墓碑。另一端至少再同步两轮，不得回到¥20。再测old line墓碑在header前页/前轮、相同订单再次被改、本机在Toast出现后已编辑、已结账订单与撤销删除。
- [ ] **2. 先保存完整旧单。** 新建 `RemoteOrderUndoRow`（Dexie v7 table `remoteOrderUndo: 'orderId, capturedAt'`）存 `before:{order,lines}`、远端版本组标识、afterFingerprint、canUndo。接收到任一会改变本机订单或其line的远端行前，先按orderId抓完整现有header+lines；line墓碑通过本地旧line反查parent。前置完整性至少满足：旧header存在、行和等于totalFen；不完整则只记录诊断，不展示撤销成功入口。
- [ ] **3. 合并跨页变更，以明细清单证明完整。** 仅凭行金额和等于total不能证明没有漏掉等额换货/赠品行。`SalesOrder`增加可选 `lineIds?: string[]`；saveRecord/updateRecord/addPatchedRecord及其撤销入口都在原业务事务将本次完整line id清单写入order。对应 `types.ts`、`repo.ts`、`recordDraft.ts` 消费与 `REMOTE_SCHEMAS` 增加字符串数组校验/投影；备份版本保持向后可读、老字段缺失不强制编造。header的 `updatedAt + lineIds`作为远端版本组；行集合精确等于lineIds、每条有合法金额数量、合计匹配、且无待决line时，才能确定after指纹。line/header跨页时首次变更前快照保留，不被后续页覆盖。

没有lineIds的旧远端订单仍可显示、同步，但涉及明细修改的H3入口仅“查看核对”，不提供未获完整性证明的自动撤销；不因为“老格式兼容”就报撤销成功。旧数据单纯作废/恢复继续走现有明确语义；新订单完整快照通过后才开放整单撤销。若后续明确新版本出现，先结束旧组或使旧撤销失效，不拼新header+旧lines。最多保留最近20组完整撤销记录，按整单淘汰；追加“金额相同但商品/赠品不同”的回归用例。
- [ ] **4. 撤销短事务。** 验证当前header+lines规范化指纹等于捕获after，若不等说明用户/其他设备后来又改过，拒绝并保留现场；不能覆盖新改动。恢复旧header/lines、删除当前额外lines、队列写入都在同个rw事务，含 orders/lines/outbox/sessions。业务时间必须比当前/远端/旧快照都更新：

```ts
const at = new Date(Math.max(Date.now(), businessTime(currentOrder) + 1,
  businessTime(snapshot.before.order) + 1, snapshot.remoteBusinessTime + 1)).toISOString();
// 恢复的header和lines都写 updatedAt:at，createdAt保持原值。
// enqueueInTx: order upsert + restored lines upsert + removed new lines delete。
```

结账场次快照重算复用现有best-effort入口；主交易已成功时不伪报失败，重算异常显示独立告警。商品已有updateProduct路径不重复改。`restoreLocalSnapshot` 不再给order走残缺通用逻辑，路由到完整订单撤销API；没有快照时返回明确错误。
- [ ] **5. 金额守恒断言。**

```ts
expect(restored.totalFen).toBe(1000);
expect(lines.reduce((n,l) => n+l.amountFen, 0)).toBe(1000);
expect(lines.reduce((n,l) => n+l.qtyBase, 0)).toBe(1);
expect(await db.outbox.get('line:new-line')).toMatchObject({ op:'delete' });
expect(Date.parse(restored.updatedAt!)).toBeGreaterThan(Date.parse(remote.updatedAt!));
```

新增快照表迁移、重启可恢复、容量清理和指纹不匹配测试。`pnpm exec vitest run tests/remote-order-undo.test.ts tests/repo.test.ts tests/session.test.ts`，再两contextE2E。commit：`fix(sync): restore complete orders with fresh revisions on remote undo`。

## B05 — 同步会话、恢复、撤销合并与重新连接

**优先级：P1；依赖：B02–B04；配合F02。Files:** 新增 `src/db/syncControl.ts`、`src/db/dataRecovery.ts`、`tests/data-recovery.test.ts`、`tests/sync-control.test.ts`；修改 `sync.ts`、`backup.ts`、`merge.ts`、`db.ts`、`ui/useSync.ts`、SettingsPage、SyncPanel；完善 `scripts/e2e-sync-recovery.py`。

- [ ] **1. 失败用例。** 快照S无订单X；云有X、本地X待推修改；恢复S后启同步，旧版会推X墓碑。另测试explicit delete队列残留、恢复前GET扣住而恢复后才返回、浏览器另一tab同步、暂停重启、导入撤销不含B-only订单。
- [ ] **2. 控制面唯一。** 新模块提供以下接口，所有sync/恢复/配置切换都调用；不允许hook busy ref和新锁各自成为事实源：

```ts
export interface SyncLease { generation:number; signal:AbortSignal }
export function pauseSync(reason:'restore'|'undo-merge'|'user'): Promise<void>;
export function runSyncExclusive<T>(work:(lease:SyncLease)=>Promise<T>):Promise<T>;
export function assertLeaseCurrent(lease:SyncLease):Promise<void>;
export function prepareReconnect(cfg:SyncConfig):Promise<ReconnectPreview>;
export type ReconnectDecision = { recordKey:string; take:'local'|'remote' };
export function confirmReconnect(preview:ReconnectPreview,
  choices:ReconnectDecision[]):Promise<void>;
export interface ReconnectPreview {
  token:string; generation:number;
  localFingerprint:string; remoteFingerprint:string;
  localOnly:number; remoteOnly:number; different:number; same:number;
  conflicts:{recordKey:string; label:string; localText:string; remoteText:string}[];
  // 完整typed backup/remote snapshot由token在会话内查回，UI只取计数与差异明细。
}
```

SyncConfig类型从sync.ts抽到小型`syncTypes.ts`（本任务新建），避免循环导入；测试按真实类型更新。Dexie v8增加`syncMeta:'key'`，存generation、paused原因、恢复待确认标记；Browser localStorage disabled作为兼容信号，不是跨tab写入防线。暂停先持久递增generation和paused，再abort网络。每次远端apply、ack、cursor/lastSync提交前，在包含syncMeta的事务里校验lease；旧代返回只能丢弃，不能污染恢复后的账本。Web Locks可用时同步与数据操作共享同名锁；不可用时用IDB持久lease，记录随机ownerId、单调fence、expiresAt，取得/续租/释放均在syncMeta短事务内compare-and-set。SyncLease相应增加ownerId/fence，提交前除generation还要核对owner/fence，过期旧持有者不能因迟到响应重新获得写权。租期30秒、每10秒续租，续租失败abort；测试冻结旧tab超过租期、新tab接管、旧tab复苏后apply/ack均被拒。BC仅通知界面，不作正确性依赖。

恢复期间数据写入口也检查syncMeta的maintenance标记，避免另一个tab在快照导出与replace之间新开单被覆盖。普通离线开单不等待网络，只在本地维护事务期间明确提示“正在恢复本机账本，请稍候”；不能持有网络请求来锁死开单。
- [ ] **3. 原子恢复。** `dataRecovery.ts`协调：先暂停/失效旧代→等待正在提交的短事务结束→生成恢复前快照→在同一IDB事务替换业务表、保留本机身份、清outbox/conflicts/待决line/remoteUndo，落恢复标记。失败回滚业务表与队列，paused保持，告诉用户失败而非自动恢复旧网络。localStorage游标/lastReplay/knownIds/error随后按新generation清理；若此步失败，下次boot依据syncMeta继续清理，不能重用旧cursor。
- [ ] **4. 撤销合并边界。** UI不调用clearCloud、不enqueueAllLocal；用原preMerge快照执行相同本机恢复流程，云端B-only行不写不删。导入正向操作所需入队也纳入其事务（业务已落库但入队失败不能显示普通“导入失败”诱发重导）；只标实际新增/更新的行，不整库重复标脏。
- [ ] **5. 重新连接先只读预览。** 下载相同ledger远端快照到内存/暂存区，不能直接apply主库。用户确认前维持paused，显示三类差异。确认时复核local/remote指纹、generation；变化则重新预览。默认策略：remote-only保留并导入；local-only完整订单组以新业务时间安全上传；同id不同内容逐单选择保留本机/采用云端，父子必须作为整体；远端墓碑单列冲突，不能当作普通local-only悄悄复活。用户未选完就不启用。绝不能把“本地缺失”推成删除，不能清整本云账。只对用户明确保留的本机订单组/商品赋新业务时间；已选择采用云端的行不入队。选择结果与远端基线指纹要原子保留，后续网络期间若出现第三方新版，则回到待核对、不用恢复快照盲目覆盖。确认后只给选定的本机保留行入队，新revision；commit恢复标记后再放开sync。
- [ ] **6. 配置切换同样隔离。** `saveSyncConfig`变成协调后的async提交，generation与cursor按URL+ledger绑定；旧账本请求不能写新账本状态。B07阶段二未确认前，仅允许保留当前ledger配置，界面明确提示迁移未就绪；不能用悄悄fallback解决跨账本冲突。
- [ ] **7. 验收。** `pnpm exec vitest run tests/data-recovery.test.ts tests/sync-control.test.ts tests/backup.test.ts tests/merge.test.ts`；`python scripts/e2e-sync-recovery.py`覆盖两tab、两context、响应倒序与进程重启。关同步后无新请求；旧请求即使服务端已收，恢复后本地也不受迟到响应污染。另一个设备唯一数据在undoMerge后仍活着。commit分控制面、恢复整合两步，不并行改同文件。

## B06 — 全云清空：事务、幂等与未知结果

**优先级：P1功能封口；依赖：B05、F02a、B07准备阶段；完成后接入F02b。Files:** 修改 `sync.ts`、`syncControl.ts`、mock；新增 `supabase/migrations/2026-11-13-stability-prepare.sql`中的RPC/receipt、`tests/clear-cloud-rpc.test.ts`；修改 `tests/clear-cloud.test.ts`、e2e-sync-recovery、docs/03。

- [ ] **1. 固定契约。** 客户端先创建UUID operationId并持久保存“待确认清空”，只发：

```http
POST /rest/v1/rpc/yh_clear_ledger
Content-Type: application/json
x-ledger-key: 本账本同步码

{"p_operation_id":"UUID"}
```

返回`{operationId,clearedAt,clearedCount}`，clearedAt为服务端毫秒；RPC从header派生ledger，不接受客户端传入任意ledger。相同operationId返回第一次结果，绝不再次清空后来新单。
- [ ] **2. SQL事务语义。** 新表`yh_clear_operations(ledger text, operation_id uuid, cleared_at bigint, cleared_count bigint, primary key(ledger,operation_id))`，RLS与账本header一致；anon仅select/insert，禁止update/delete。函数默认`SECURITY INVOKER`，固定search_path、撤销PUBLIC execute、只给anon execute。函数内部先`pg_advisory_xact_lock`按ledger串行化：查receipt存在则返回；否则同一事务将该ledger业务行软删、upsert现有`__ledger_cleared__:<ledger>`标记（conflict ledger,id），写receipt，再返回。任何一步抛错，整事务回滚。

```sql
-- 函数体中的关键语义；完整函数/返回类型在此任务迁移文件中定义并由集成测试执行。
select pg_advisory_xact_lock(hashtextextended(v_ledger, 0));
select * into v_existing from public.yh_clear_operations
 where ledger=v_ledger and operation_id=p_operation_id;
-- FOUND则直接返回v_existing；否则执行UPDATE/marker INSERT/receipt INSERT。
```

拒绝空header、超长非法操作id、写入他账本；不使用service_role或SECURITY DEFINER来绕过RLS。公开共享码的既有访问边界未改变，不承诺具备登录权限系统。
- [ ] **3. 客户端无两请求回退。** clearCloud经B05独占同步并锁定UI；未部署RPC明确“云端尚未升级，未清空”，保留本机。网络超时可能是已提交但响应丢失，状态为`unknown`，保留相同operationId；查询receipt或重试同id确认。不能生成新id后“再清一次”，否则会抹掉清空后的新单。
- [ ] **4. 两端清空代际。** 接收清空标记时先失效旧代再处理旧outbox，不能仅凭不同设备queuedAt与clearedAt的时钟比较。准备迁移新增 `yh_records.clear_epoch bigint not null default 0`（独立于业务updatedAt）；`yh_ledger_state(ledger text primary key, clear_epoch bigint not null default 0)`存服务端现役代。清空RPC在同一事务递增该ledger代际（取max(旧值+1,服务端毫秒)），更新既有行墓碑的epoch、marker和receipt；服务器行级触发器要求INSERT/UPDATE的NEW.clear_epoch等于该ledger当前值，否则抛明确错误。state从未清空过时epoch=0，旧端默认0仍能用；第一次新协议清空后，旧端不带epoch会被拒绝，不能继续复活旧账。state由受限 `SECURITY DEFINER` helper更新/读取：固定 `search_path=pg_catalog,public`、schema限定对象、校验header ledger，无动态SQL、不向anon授予直接state写权限；业务RPC保持INVOKER。测试helper无法跨账本修改state。

客户端 outbox 每次入队保存当时已观察的 `clearEpoch`；标记变化时该ledger旧epoch待推项进入恢复前备份/隔离区，不自动重贴新epoch发送。客户端初次上线先读/确认当前epoch再push，缺失能力时禁全云清空；服务端“旧epoch”错误先暂停push、拉标记，不通用重试原payload。清空之后新单仅使用新epoch；旧PWA在B07验收中明确拒绝并引导升级。行主键仍用原业务id，不通过改id绕过epoch检查。

并发约束：所有业务INSERT/UPDATE的epoch检查触发器必须取得与清空RPC**相同ledger的事务级advisory lock**后再读取state，锁保持到事务结束。否则写事务可能在清空前通过epoch检查、清空后才提交并复活旧账。UPDATE/UPSERT时marker也遵守新epoch；helper仅负责受限state，不替业务写绕过RLS。prepare只增加默认epoch=0与能力标志 `clearRpcEnabled=false`；finalize在两端确认升级、事务测试通过后才启用清空RPC/epoch切换，不可在兼容旧PWA阶段提前执行第一次清空。RPC失败/timeout重试始终沿用原operationId。
- [ ] **5. 故障注入测试。** SQL层marker故意失败应0业务行被删；RPC重放同id两次之间插新单，第二次不得删新单；两个不同id并发按ledger串行；他账本不变；timeout后receipt能确认；无RPC时不动本机。`pnpm exec vitest run tests/clear-cloud-rpc.test.ts tests/clear-cloud.test.ts tests/sync-control.test.ts`、本地PostgreSQL/PostgREST/RLS集成、E2E慢网取消/重入全部通过。
- [ ] **6. 提交。** `fix(sync): clear ledgers transactionally with idempotent operation receipts`。生产部署只交付人工步骤，不能因本地测试通过自动执行。

## B07 — 补列、复合账本主键与协议升级

**优先级：P1；依赖：B01、B05；RPC在准备阶段包含，最终联调B06。Files:** 修改schema.sql、sync.ts、mock、SyncPanel（F03主责）、docs/03/08；新增prepare/finalize迁移、`supabase/tests/stability.sql`、`tests/sync-ledger.test.ts`；修改sync-cursor/clear-cloud测试。

- [ ] **1. 先本地检验旧新数据库。** 对空库、缺record_updated_at/schema_version的旧表、现行v5策略库分别跑prepare两次。必须保留所有旧行；不能DROP TABLE，也不能复制成第二张业务表后静默切换。
- [ ] **2. 准备阶段保留旧主键。**

```sql
alter table public.yh_records add column if not exists record_updated_at bigint not null default 0;
alter table public.yh_records add column if not exists schema_version int not null default 1;
create unique index if not exists yh_records_ledger_id_uq on public.yh_records(ledger,id);
notify pgrst, 'reload schema';
```

prepare还建B06 receipt/RPC及协议能力检查`yh_sync_capabilities`（返回复合冲突支持/全云RPC版本/清空epoch要求，不含凭据），按schema实际内容实现。不能仅用客户端乐观猜测列存在。此阶段原全表id PK仍在，所以新ledger入口保持关闭。
- [ ] **3. 兼容客户端。** capabilities可用且版本匹配后推送`on_conflict=ledger,id`；仍保留业务行id=`kind:recordId`，远端cursor id不改变。无capabilities仅允许原账本常规同步使用legacy on_conflict=id，明确“待升级”；禁全云清空和换ledger。RPC/capabilities的404与网络超时不可混为schema缺列降级。
- [ ] **4. 两台设备确认同build后完成主键迁移。** 查询pg_constraint得到真实主键名并断言它正是单列id；不猜名字、不CASCADE。短事务删旧PK，将上面复合unique index转primary key；如果已为复合PK则安全退出。保留(ledger,updated_at,id)索引、三条RLS与禁止DELETE。

```sql
-- 在检查实际旧主键名/列、确认无外部FK后执行（完整DO块由任务实现）。
alter table public.yh_records drop constraint yh_records_pkey;
alter table public.yh_records add constraint yh_records_pkey
 primary key using index yh_records_ledger_id_uq;
notify pgrst, 'reload schema';
```

上面constraint名只是该项目默认形态的示例，正式迁移必须使用前一步查出的名字；未满足前置条件直接RAISE，不能靠删数据解决。schema.sql新建库直接采用复合PK；它不冒充能替代所有旧库迁移。F03 raw帮助须区分新库和升级顺序。
- [ ] **5. 多账本端到端。** 同项目ledger A/B分别seed相同sample及setting，9个id重合也应能各自upsert；A修改、清空不改变B；同账本重发不重复；换ledger重置cursor并让旧响应失效；从备份导入保留UUID。PostgREST实际HTTP测试用anon角色/header，不能只以SQL owner绕RLS执行。
- [ ] **6. 旧端和clear epoch策略。** finalize后的on_conflict=id旧客户端会失败，不允许伪装成功。生产先核对两个PWA build；能力检测失败显示升级引导。B06涉及清空epoch后旧端写入必须被服务端规则拒绝/隔离，在本地混版本测试明确验证；不能承诺“任意旧端继续工作”。备份及手动导入作为离线兜底，而非绕过新协议写云端。
- [ ] **7. 回滚及验收。** prepare可保留附加列/索引不伤旧客户端；新前端回滚只能回到支持复合冲突的已验构建。finalize后数据跨ledger同id合法，禁止自动恢复全表id唯一。执行`pnpm exec vitest run tests/sync-ledger.test.ts tests/sync-cursor.test.ts tests/clear-cloud-rpc.test.ts tests/mock-supabase.test.ts`；独立测试库运行SQL/RLS套件，证明准备/完成脚本幂等、旧行数与内容哈希不变，最后完整门禁与两台真机。
- [ ] **8. 可重复运行的集成命令。** 新建 `scripts/e2e-supabase-protocol.py`（本任务文件列表的一部分），环境 `YH_PROTOCOL_TEST_URL/KEY` 必须全部设置且URL为loopback，否则退出；所有ledger用每次运行的随机前缀，不接受内置生产ledger。脚本用Python标准库HTTP执行anon请求，依次验证复合id、RLS、RPC、幂等重试、旧epoch写入拒绝与并发清空/写入。只允许清理本次随机ledger，无全表清理。SQL套件为事务包裹并最终ROLLBACK；运行前要求 `psql` 目标为独立测试DB且显式 `YH_TEST_DATABASE_URL` 为loopback。

```powershell
psql "$env:YH_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/stability.sql
python scripts/e2e-supabase-protocol.py
```

前置条件/版本/准备与完成阶段都由脚本输出；未配置环境应失败并标“未验证”，不能skip为绿。只含mock的CI不声称SQL已验；本机隔离环境或另设CI服务完成实证。
- [ ] **9. 提交。** prepare、兼容客户端、finalize各自commit；写清生产尚未执行。`fix(sync): scope record uniqueness to ledgers with staged migration`。

## 后端关闭条件

- [ ] outbox同id新修订不会被旧ack删除；入站与本地写的pending检查同事务。
- [ ] 跨页line不丢，重启后可补齐，暂缺父单不会当已删除；未完整同步状态不报完成。
- [ ] 所有收入/数量/成本/让利有限且单头=明细和；撤销是整单、时间新、后续编辑有保护。
- [ ] 恢复先暂停、旧响应不落新库、旧队列不发墓碑；撤销合并不写全云清空。
- [ ] 清空单RPC、同操作id幂等；未知结果不误清、重试不删后来新单。
- [ ] 多ledger重复业务id合法且RLS隔离，迁移保数据、混版本行为明确。
- [ ] 本地mock/真实SQL-RLS/真机分别给证据；缺任何一面如实pending。
