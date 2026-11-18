// 性能基线（独立运行：pnpm perf；不进 pnpm test，避免把采样耗时带进日常回归）
// 规模：200 商品 / 400 批次 / 3000 单 / 6000 明细 / 40 场次 / 200 调整
import 'fake-indexeddb/auto';
import { describe, it } from 'vitest';
import { db } from '../../src/db/db';
import { fifoAllocate, inventoryMap, productAvgCostFen, sessionReport, sessionReports } from '../../src/db/calc';
import { fifoAllocateLegacy } from './calc-legacy';
import { loadAll, refreshSessionSummary, saveRecord, updateRecord } from '../../src/db/repo';
import type { Adjustment, Batch, Product, SaleLine, SalesOrder, Session } from '../../src/db/types';

const DEVICE = 'dev-perf';
const T0 = Date.parse('2026-10-01T02:00:00.000Z');
const PRODUCTS = 200;
const BATCHES = 400;
const ORDERS = 3000;
const LINES_PER_ORDER = 2;
const SESSIONS = 40;

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

function stat(name: string, xs: number[]): { name: string; n: number; p50: number; p95: number } {
  const r = {
    name,
    n: xs.length,
    p50: Number(pct(xs, 0.5).toFixed(1)),
    p95: Number(pct(xs, 0.95).toFixed(1))
  };
  console.log(`${name.padEnd(34)} p50=${String(r.p50).padStart(9)}ms p95=${String(r.p95).padStart(9)}ms`);
  return r;
}

async function seed(): Promise<void> {
  await Promise.all([
    db.products.clear(),
    db.batches.clear(),
    db.orders.clear(),
    db.lines.clear(),
    db.adjustments.clear(),
    db.sessions.clear(),
    db.settings.clear(),
    db.outbox.clear(),
    db.conflicts.clear()
  ]);

  const products: Product[] = [];
  for (let i = 0; i < PRODUCTS; i++) {
    products.push({
      id: `p${i}`,
      name: `商品${i}`,
      category: i % 2 === 0 ? '炮' : '烟花',
      unitBase: '个',
      boxQty: 10,
      priceList: 1000 + i,
      negotiable: true,
      archived: false,
      sortOrder: i,
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString()
    });
  }

  const batches: Batch[] = [];
  for (let i = 0; i < BATCHES; i++) {
    const pid = `p${i % PRODUCTS}`;
    const at = new Date(T0 + i * 3600_000).toISOString();
    batches.push({
      id: `b${i}`,
      productId: pid,
      qtyBase: 100000,
      unitCostFen: 500 + (i % 7),
      receivedAt: at.slice(0, 10),
      deviceId: DEVICE,
      createdAt: at,
      updatedAt: at
    });
  }

  const sessions: Session[] = [];
  for (let s = 0; s < SESSIONS; s++) {
    const started = T0 + s * 86_400_000;
    sessions.push({
      id: `s${s}`,
      deviceId: DEVICE,
      startedAt: new Date(started).toISOString(),
      closedAt: new Date(started + 10 * 3600_000).toISOString(),
      status: 'closed',
      openedBy: '我',
      closedBy: '我',
      patchedCount: 0,
      updatedAt: new Date(started + 10 * 3600_000).toISOString()
    });
  }

  const orders: SalesOrder[] = [];
  const lines: SaleLine[] = [];
  for (let i = 0; i < ORDERS; i++) {
    const s = `s${Math.floor((i / ORDERS) * SESSIONS)}`;
    const at = new Date(T0 + i * 600_000).toISOString();
    const oid = `o${i}`;
    let total = 0;
    for (let k = 0; k < LINES_PER_ORDER; k++) {
      const pid = `p${(i * LINES_PER_ORDER + k) % PRODUCTS}`;
      const qty = 1 + ((i + k) % 5);
      const amount = qty * (1000 + ((i + k) % 200));
      total += amount;
      lines.push({
        id: `l${i}_${k}`,
        orderId: oid,
        productId: pid,
        qtyBase: qty,
        unit: 'base',
        qty,
        listUnitPriceFen: 1000,
        unitPriceFen: Math.round(amount / qty),
        amountFen: amount,
        discountFen: 0,
        updatedAt: at
      });
    }
    orders.push({
      id: oid,
      deviceId: DEVICE,
      operator: '我',
      createdAt: at,
      payMethod: i % 3 === 0 ? 'cash' : i % 3 === 1 ? 'wechat' : 'alipay',
      totalFen: total,
      sessionId: s,
      updatedAt: at
    });
  }

  const adjustments: Adjustment[] = [];
  for (let i = 0; i < 200; i++) {
    adjustments.push({
      id: `a${i}`,
      productId: `p${i % PRODUCTS}`,
      qtyBase: i % 2 === 0 ? -2 : 3,
      type: i % 2 === 0 ? 'loss' : 'correction',
      createdAt: new Date(T0 + i * 60_000).toISOString(),
      deviceId: DEVICE,
      updatedAt: new Date(T0 + i * 60_000).toISOString()
    });
  }

  await db.transaction(
    'rw',
    [db.products, db.batches, db.orders, db.lines, db.adjustments, db.sessions],
    async () => {
      await db.products.bulkPut(products);
      await db.batches.bulkPut(batches);
      await db.sessions.bulkPut(sessions);
      await db.orders.bulkPut(orders);
      await db.lines.bulkPut(lines);
      await db.adjustments.bulkPut(adjustments);
    }
  );
}

describe('性能基线', () => {
  it('测量主要接口', async () => {
    const t0 = performance.now();
    await seed();
    console.log(`seed ${ORDERS} 单 / ${ORDERS * LINES_PER_ORDER} 明细：${(performance.now() - t0).toFixed(0)}ms`);

    const data = await loadAll();
    const fifo = fifoAllocate(data.batches, data.orders, data.lines);
    const out: Record<string, unknown> = {};

    // 1) 全量读取（useLiveQuery(loadAll) 每次写入后都会跑）
    const loadAllTimes: number[] = [];
    for (let i = 0; i < 21; i++) {
      const s = performance.now();
      await loadAll();
      const d = performance.now() - s;
      if (i > 0) loadAllTimes.push(d);
    }
    out.loadAll = stat('loadAll() 全表读取', loadAllTimes);

    // 1b) 同一份数据放在单个只读事务里读（候选优化）
    const loadAllTx = async (): Promise<unknown> =>
      db.transaction(
        'r',
        [db.products, db.batches, db.orders, db.lines, db.adjustments, db.sessions, db.settings],
        async () => {
          const [products, batches, orders, lines, adjustments, sessions, settings] =
            await Promise.all([
              db.products.toArray(),
              db.batches.toArray(),
              db.orders.toArray(),
              db.lines.toArray(),
              db.adjustments.toArray(),
              db.sessions.toArray(),
              db.settings.toArray()
            ]);
          return { products, batches, orders, lines, adjustments, sessions, settings };
        }
      );
    const loadAllTxTimes: number[] = [];
    for (let i = 0; i < 21; i++) {
      const s = performance.now();
      await loadAllTx();
      const d = performance.now() - s;
      if (i > 0) loadAllTxTimes.push(d);
    }
    out.loadAllTx = stat('loadAll() 单只读事务', loadAllTxTimes);

    // 2) FIFO 重放（loadAll 之后 App 每次都要算）：新实现与优化前实现同进程交替采样
    const fifoTimes: number[] = [];
    const fifoLegacyTimes: number[] = [];
    for (let i = 0; i < 15; i++) {
      let s = performance.now();
      fifoAllocate(data.batches, data.orders, data.lines);
      let d = performance.now() - s;
      if (i > 0) fifoTimes.push(d);
      s = performance.now();
      fifoAllocateLegacy(data.batches, data.orders, data.lines);
      d = performance.now() - s;
      if (i > 0) fifoLegacyTimes.push(d);
    }
    out.fifo = stat('fifoAllocate() 优化后', fifoTimes);
    out.fifoLegacy = stat('fifoAllocate() 优化前', fifoLegacyTimes);
    const fNew = fifoAllocate(data.batches, data.orders, data.lines);
    const fOld = fifoAllocateLegacy(data.batches, data.orders, data.lines);
    let fifoSame = fNew.batchRemaining.size === fOld.batchRemaining.size;
    for (const [id, v] of fNew.batchRemaining) if (fOld.batchRemaining.get(id) !== v) fifoSame = false;
    for (const [id, v] of fNew.lineCost) if (fOld.lineCost.get(id) !== v) fifoSame = false;
    out.fifoResultIdentical =
      fifoSame &&
      fNew.uncoveredQty === fOld.uncoveredQty &&
      fNew.uncoveredCostFen === fOld.uncoveredCostFen;
    console.log(`FIFO 结果与优化前逐值一致：${out.fifoResultIdentical ? '是' : '否'}`);

    // 3) 库存图
    const invTimes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const s = performance.now();
      inventoryMap(data.batches, data.orders, data.lines, data.adjustments);
      const d = performance.now() - s;
      if (i > 0) invTimes.push(d);
    }
    out.inventory = stat('inventoryMap()', invTimes);

    // 4) 平均成本（App.tsx 又单独算了一遍）
    const avgTimes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const s = performance.now();
      productAvgCostFen(data.batches);
      const d = performance.now() - s;
      if (i > 0) avgTimes.push(d);
    }
    out.avgCost = stat('productAvgCostFen()', avgTimes);

// 5) 报表页：40 场次汇总
    const sessionIds = Array.from({ length: SESSIONS }, (_, i) => `s${i}`);
    const reportRound: number[] = [];
    for (let round = 0; round < 6; round++) {
      const s = performance.now();
      for (const id of sessionIds) sessionReport(id, data.orders, data.lines, fifo);
      const d = performance.now() - s;
      if (round > 0) reportRound.push(d);
    }
    out.reportAllSessionsLegacy = stat('sessionReport × 40 场（旧路径）', reportRound);

    const batchReportRound: number[] = [];
    for (let round = 0; round < 6; round++) {
      const s = performance.now();
      sessionReports(sessionIds, data.orders, data.lines, fifo);
      const d = performance.now() - s;
      if (round > 0) batchReportRound.push(d);
    }
    out.reportAllSessions = stat('sessionReports × 40 场（批量）', batchReportRound);

    // 6) 单场报表
    const reportOne: number[] = [];
    for (let i = 0; i < 11; i++) {
      const s = performance.now();
      sessionReport('s0', data.orders, data.lines, fifo);
      const d = performance.now() - s;
      if (i > 0) reportOne.push(d);
    }
    out.reportOne = stat('sessionReport 单场', reportOne);

// 7) 写一单（含事务 + 发件箱 + useLiveQuery 之外的数据层耗时）
    await db.outbox.clear();
    const saveTimes: number[] = [];
    let savedOrderId = '';
    for (let i = 0; i < 31; i++) {
      const s = performance.now();
      const saved = await saveRecord({
        deviceId: DEVICE,
        operator: '我',
        payMethod: 'cash',
        lines: [
          { productId: 'p1', qtyBase: 2, unit: 'base', qty: 2, listUnitPriceFen: 1000, unitPriceFen: 1000, amountFen: 2000 },
          { productId: 'p2', qtyBase: 1, unit: 'base', qty: 1, listUnitPriceFen: 1000, unitPriceFen: 1000, amountFen: 1000 }
        ]
      });
      savedOrderId = saved.id;
      const d = performance.now() - s;
      if (i > 0) saveTimes.push(d);
    }
    out.saveRecord = stat('saveRecord() 写一单', saveTimes);

    // 8) 改一单（整组替换明细）：耗时 + 发件箱行数增量
    const orderId = savedOrderId;
    const beforeOutbox = await db.outbox.count();
    const updTimes: number[] = [];
    for (let i = 0; i < 21; i++) {
      const s = performance.now();
      await updateRecord(orderId, {
        deviceId: DEVICE,
        operator: '我',
        payMethod: 'cash',
        lines: [
          { productId: 'p3', qtyBase: 2, unit: 'base', qty: 2, listUnitPriceFen: 1000, unitPriceFen: 1000, amountFen: 2000 },
          { productId: 'p4', qtyBase: 1, unit: 'base', qty: 1, listUnitPriceFen: 1000, unitPriceFen: 1000, amountFen: 1000 }
        ]
      });
      const d = performance.now() - s;
      if (i > 0) updTimes.push(d);
    }
    out.updateRecord = stat('updateRecord() 改一单', updTimes);
    out.updateRecordOutboxRows = (await db.outbox.count()) - beforeOutbox;

    // 9) 已结账场次快照重算（作废/补记/删除路径）
    await refreshSessionSummary('s0');
    const refreshTimes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const s = performance.now();
      await refreshSessionSummary('s0');
      const d = performance.now() - s;
      if (i > 0) refreshTimes.push(d);
    }
out.refreshSummary = stat('refreshSessionSummary()', refreshTimes);

    // 10) 冲突留痕写入：每页 40 条，旧「逐条 first + put」vs 新「anyOf + bulkPut」
    const makeConflicts = () =>
      Array.from({ length: 40 }, (_, i) => ({
        at: new Date(T0 + i * 1000).toISOString(),
        kind: 'order',
        recordId: `c${i}`,
        local: '{"totalFen":100}',
        remote: '{"totalFen":200}'
      }));

    await db.conflicts.clear();
    let s10 = performance.now();
    for (const row of makeConflicts()) {
      const existing = await db.conflicts
        .where('[kind+recordId]')
        .equals([row.kind, row.recordId])
        .first();
      if (existing && typeof existing.id === 'number') await db.conflicts.put({ ...row, id: existing.id });
      else await db.conflicts.add(row);
    }
    out.conflictsLegacy = Number((performance.now() - s10).toFixed(1));

    await db.conflicts.clear();
    s10 = performance.now();
    const rows10 = makeConflicts();
    await db.transaction('rw', db.conflicts, async () => {
      const existing = await db.conflicts
        .where('[kind+recordId]')
        .anyOf(rows10.map((r) => [r.kind, r.recordId] as [string, string]))
        .toArray();
      const idOf = new Map(existing.map((r) => [`${r.kind}:${r.recordId}`, r.id as number]));
      await db.conflicts.bulkPut(
        rows10.map((r) => ({ ...r, ...(idOf.has(`${r.kind}:${r.recordId}`) ? { id: idOf.get(`${r.kind}:${r.recordId}`) } : {}) }))
      );
    });
    out.conflictsBatch = Number((performance.now() - s10).toFixed(1));
    console.log(
      `saveConflicts 40 条（首次写入）        旧=${out.conflictsLegacy}ms 新=${out.conflictsBatch}ms`
    );

console.log(`\n基线 JSON：${JSON.stringify(out)}`);
  }, 120_000);
});





