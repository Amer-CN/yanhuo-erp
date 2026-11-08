"""数据接口性能基准：真实 Chromium + IndexedDB 上直接调用 src/db/repo.ts 的公共接口。

用法（需先 `pnpm dev`）：
    python scripts/perf-bench.py --label base --orders 6000
    python scripts/perf-bench.py --label opt  --orders 6000

输出：E:\\Temp\\perf-<label>.json（带 P50/P95/P99），不写入仓库。
"""

import argparse
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5173/perf.html"

JS = r"""
async (cfg) => {
  const { repo, db, calc } = window.__perf;
  await db.open();

  const TABLES = ['products', 'batches', 'orders', 'lines', 'adjustments', 'sessions', 'settings', 'outbox'];
  const wipe = async () => { await Promise.all(TABLES.map((t) => db.table(t).clear())); };
  await wipe();

  const iso = (ms) => new Date(ms).toISOString();
  const bulk = async (table, rows, size = 2000) => {
    for (let i = 0; i < rows.length; i += size) await table.bulkPut(rows.slice(i, i + size));
  };

  /* ---------------- 生成代表性数据 ---------------- */
  const PRODUCTS = 50;
  const BATCHES = 500;
  const SESSION_SIZE = cfg.sessionSize;
  const N = cfg.orders;

  const products = [];
  for (let i = 0; i < PRODUCTS; i++) {
    products.push({
      id: `p${i}`, name: `商品${i}`, category: ['炮', '烟花', '儿童', '组合'][i % 4],
      unitBase: '个', boxQty: 10, priceList: 200, negotiable: true, archived: false,
      sortOrder: i, createdAt: iso(Date.parse('2026-09-01T00:00:00+08:00')), updatedAt: iso(Date.now())
    });
  }

  const batches = [];
  for (let i = 0; i < BATCHES; i++) {
    batches.push({
      id: `b${i}`, productId: `p${i % PRODUCTS}`, batchNo: `B${i}`,
      produceDate: '2026-08-01', expiryDate: '2027-08-01',
      qtyBase: 20000, unitCostFen: 80 + (i % 40),
      supplier: '供货商', receivedAt: '2026-09-20',
      deviceId: 'dev1', createdAt: iso(Date.parse('2026-09-20T09:00:00+08:00') + i * 1000)
    });
  }

  const sessionCount = Math.max(2, Math.floor(N / SESSION_SIZE));
  const orders = [];
  const lines = [];
  const sessions = [];
  let t = Date.parse('2026-10-01T09:00:00+08:00');
  let oi = 0, li = 0;
  for (let s = 0; s < sessionCount; s++) {
    const sid = `s${s}`;
    const start = t;
    sessions.push({
      id: sid, deviceId: 'dev1', startedAt: iso(start), status: 'closed',
      openedBy: '我', closedBy: '我', patchedCount: 0, updatedAt: iso(start)
    });
    for (let k = 0; k < SESSION_SIZE && oi < N; k++, oi++) {
      t += 30000;
      const oid = `o${oi}`;
      let total = 0;
      for (let j = 0; j < cfg.linesPerOrder; j++, li++) {
        const pid = `p${(oi * cfg.linesPerOrder + j) % PRODUCTS}`;
        const qtyBase = 1 + ((oi + j) % 4);
        const amountFen = qtyBase * 150;
        total += amountFen;
        lines.push({
          id: `l${li}`, orderId: oid, productId: pid, qtyBase, unit: 'base', qty: qtyBase,
          listUnitPriceFen: 200, unitPriceFen: 150, amountFen, discountFen: qtyBase * 50
        });
      }
      orders.push({
        id: oid, deviceId: 'dev1', operator: '我', createdAt: iso(t),
        payMethod: ['cash', 'wechat', 'alipay'][oi % 3], totalFen: total, sessionId: sid
      });
    }
    sessions[s].closedAt = iso(t);
  }
  // 单独一场进行中的场次，供 saveRecord 使用
  const openSession = {
    id: 'open1', deviceId: 'dev1', startedAt: iso(t + 3600000), status: 'open',
    openedBy: '我', patchedCount: 0, updatedAt: iso(t + 3600000)
  };
  sessions.push(openSession);

  await bulk(db.products, products);
  await bulk(db.batches, batches);
  await bulk(db.sessions, sessions);
  await bulk(db.orders, orders);
  await bulk(db.lines, lines);
  await db.settings.put({ key: 'deviceId', value: 'dev1' });

  const dataVolume = {
    products: products.length, batches: batches.length, sessions: sessions.length,
    orders: orders.length, lines: lines.length
  };

  /* ---------------- 计时工具 ---------------- */
  const stats = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    return {
      n: s.length, mean: +mean.toFixed(2), p50: +q(0.5).toFixed(2),
      p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2),
      min: +s[0].toFixed(2), max: +s[s.length - 1].toFixed(2)
    };
  };

  async function bench(n, fn, reset) {
    await fn();
    if (reset) await reset();
    const samples = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await fn();
      samples.push(performance.now() - t0);
      if (reset) await reset();
    }
    return stats(samples);
  }

  const target = sessions[0]; // 结账/重算的目标场次
  const out = {};

  /* ---------------- 1. 全量数据读取（IO 下界） ---------------- */
  out.readAllTables = await bench(cfg.n, () =>
    Promise.all([db.orders.toArray(), db.lines.toArray(), db.batches.toArray()])
  );

  /* ---------------- 2. 纯计算耗时 ---------------- */
  const snapshot = await repo.loadAll();
  out.fifoAllocate = await bench(cfg.n, () => {
    calc.fifoAllocate(snapshot.batches, snapshot.orders, snapshot.lines);
  });
  const fifo = calc.fifoAllocate(snapshot.batches, snapshot.orders, snapshot.lines);
  out.sessionReport = await bench(cfg.n, () => {
    calc.sessionReport(target.id, snapshot.orders, snapshot.lines, fifo);
  });

  /* ---------------- 3. 接口：refreshSessionSummary ---------------- */
  out.refreshSessionSummary = await bench(cfg.n, () => repo.refreshSessionSummary(target.id));

  /* ---------------- 4. 接口：closeSession ---------------- */
  const reopenTarget = async () => {
    const s = { ...target, status: 'open', updatedAt: iso(Date.now()) };
    delete s.closedAt; delete s.closedBy; delete s.summary;
    await db.sessions.put(s);
    await db.outbox.clear();
  };
  await reopenTarget();
  out.closeSession = await bench(cfg.n, () => repo.closeSession(target.id, '我'), reopenTarget);

  /* ---------------- 5. 接口：addPatchedRecord ---------------- */
  await reopenTarget();
  await db.sessions.put({ ...target, status: 'closed', closedAt: iso(Date.now()) });
  const patchInput = (id) => ({
    deviceId: 'dev1', operator: '我', payMethod: 'cash', sessionId: target.id,
    note: 'perf',
    lines: [
      { productId: 'p1', qtyBase: 2, unit: 'base', qty: 2, listUnitPriceFen: 200, unitPriceFen: 150, amountFen: 300 },
      { productId: 'p2', qtyBase: 1, unit: 'base', qty: 1, listUnitPriceFen: 200, unitPriceFen: 150, amountFen: 150 },
      { productId: 'p3', qtyBase: 3, unit: 'base', qty: 3, listUnitPriceFen: 200, unitPriceFen: 150, amountFen: 450 }
    ]
  });
  let lastPatched = null;
  const resetPatched = async () => {
    if (lastPatched) {
      await db.lines.where('orderId').equals(lastPatched.id).delete();
      await db.orders.delete(lastPatched.id);
      const cur = await db.sessions.get(target.id);
      await db.sessions.put({ ...cur, patchedCount: target.patchedCount, summary: target.summary });
      lastPatched = null;
    }
    await db.outbox.clear();
  };
  out.addPatchedRecord = await bench(
    cfg.n,
    async () => { lastPatched = await repo.addPatchedRecord(patchInput()); },
    resetPatched
  );

  /* ---------------- 6. 接口：saveRecord（开单热路径） ---------------- */
  let lastSaved = null;
  const resetSaved = async () => {
    if (lastSaved) {
      await db.lines.where('orderId').equals(lastSaved.id).delete();
      await db.orders.delete(lastSaved.id);
      lastSaved = null;
    }
    await db.outbox.clear();
  };
  out.saveRecord = await bench(
    cfg.n,
    async () => {
      lastSaved = await repo.saveRecord({
        deviceId: 'dev1', operator: '我', payMethod: 'wechat',
        lines: [
          { productId: 'p1', qtyBase: 2, unit: 'base', qty: 2, listUnitPriceFen: 200, unitPriceFen: 150, amountFen: 300 },
          { productId: 'p2', qtyBase: 1, unit: 'base', qty: 1, listUnitPriceFen: 200, unitPriceFen: 150, amountFen: 150 }
        ]
      });
    },
    resetSaved
  );

  /* ---------------- 7. 接口：loadAll（报表/首屏数据加载） ---------------- */
  out.loadAll = await bench(cfg.n, () => repo.loadAll());

  await db.outbox.clear();
  return { dataVolume, results: out };
}
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="base")
    ap.add_argument("--orders", type=int, default=6000)
    ap.add_argument("--session-size", type=int, default=150)
    ap.add_argument("--lines-per-order", type=int, default=3)
    ap.add_argument("--n", type=int, default=12, help="每个接口的计时样本数")
    ap.add_argument("--out", default=r"E:\Temp")
    args = ap.parse_args()

    cfg = {
        "orders": args.orders,
        "sessionSize": args.session_size,
        "linesPerOrder": args.lines_per_order,
        "n": args.n,
    }

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(locale="zh-CN", timezone_id="Asia/Shanghai")
        ctx.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
        page = ctx.new_page()
        page.on("pageerror", lambda e: print("pageerror:", e))
        for _ in range(60):
            try:
                page.goto(BASE, wait_until="load", timeout=8000)
                break
            except Exception:
                time.sleep(0.5)
        page.wait_for_function("window.__perfReady === true", timeout=30000)
        payload = page.evaluate(JS, cfg)
        browser.close()

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, f"perf-{args.label}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"label": args.label, "cfg": cfg, **payload}, f, ensure_ascii=False, indent=2)

    vol = payload["dataVolume"]
    print(f"[{args.label}] 数据量: {vol['orders']} 单 / {vol['lines']} 行 / "
          f"{vol['batches']} 批次 / {vol['sessions']} 场次")
    print(f"{'接口':<24}{'mean':>9}{'P50':>9}{'P95':>9}{'P99':>9}")
    for name, s in payload["results"].items():
        print(f"{name:<24}{s['mean']:>9.1f}{s['p50']:>9.1f}{s['p95']:>9.1f}{s['p99']:>9.1f}")
    print(f"\n结果 -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())