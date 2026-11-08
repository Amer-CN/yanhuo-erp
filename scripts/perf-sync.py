"""云同步接口性能基准：真实 Chromium + IndexedDB + 本地假 Supabase。

用法（需先 `pnpm dev` 和 `node scripts/mock-supabase.mjs 54321`）：
    python scripts/perf-sync.py --label base
    python scripts/perf-sync.py --label opt

输出：E:\\Temp\\perf\\perf-sync-<label>.json
"""

import argparse
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5173/perf.html"
REMOTE = "http://127.0.0.1:54321/rest/v1/yh_records"
LEDGER = "perf-ledger-1"

JS = r"""
async (cfg) => {
  const { db } = window.__perf;
  const sync = await import('/src/db/sync.ts');
  await db.open();

  localStorage.removeItem('yh-sync-disabled');
  localStorage.setItem('yh-sync-url', 'http://127.0.0.1:54321');
  localStorage.setItem('yh-sync-anon', 'test-anon');
  localStorage.setItem('yh-sync-ledger', cfg.ledger);
  localStorage.removeItem('yh-sync-last-pull');

  const TABLES = ['products', 'batches', 'orders', 'lines', 'adjustments', 'sessions', 'settings', 'outbox'];
  const wipeLocal = async () => { await Promise.all(TABLES.map((t) => db.table(t).clear())); };
  const bulk = async (table, rows, size = 2000) => {
    for (let i = 0; i < rows.length; i += size) await table.bulkPut(rows.slice(i, i + size));
  };
  const iso = (ms) => new Date(ms).toISOString();

  const remote = (method, body) =>
    fetch(cfg.remote, {
      method,
      headers: { 'content-type': 'application/json', 'x-ledger-key': cfg.ledger },
      body: body ? JSON.stringify(body) : undefined
    });

  const stats = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
    return {
      n: s.length,
      mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1),
      p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), p99: +q(0.99).toFixed(1),
      min: +s[0].toFixed(1), max: +s[s.length - 1].toFixed(1)
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

  const out = {};

  /* ---------------- A. push：300 条发件箱（逐条 getLocal） ---------------- */
  const PUSH = 300;
  const pushOrders = [];
  const pushLines = [];
  for (let i = 0; i < 150; i++) {
    pushOrders.push({
      id: `po${i}`, deviceId: 'dev1', operator: '我', createdAt: iso(Date.parse('2026-10-05T10:00:00+08:00') + i * 1000),
      payMethod: 'cash', totalFen: 300, sessionId: 's0'
    });
    pushLines.push({
      id: `pl${i}`, orderId: `po${i}`, productId: 'p1', qtyBase: 2, unit: 'base', qty: 2,
      listUnitPriceFen: 200, unitPriceFen: 150, amountFen: 300, discountFen: 100
    });
  }
  const outboxRows = [
    ...pushOrders.map((o, i) => ({ id: `order:${o.id}`, kind: 'order', recordId: o.id, op: 'upsert', queuedAt: i })),
    ...pushLines.map((l, i) => ({ id: `line:${l.id}`, kind: 'line', recordId: l.id, op: 'upsert', queuedAt: 1000 + i }))
  ].slice(0, PUSH);

  const resetPush = async () => {
    await wipeLocal();
    await bulk(db.orders, pushOrders);
    await bulk(db.lines, pushLines);
    await bulk(db.outbox, outboxRows);
    localStorage.setItem('yh-sync-last-pull', String(Date.now()));
  };

  await remote('DELETE');
  await resetPush();
  out.push300 = await bench(cfg.n, () => sync.syncNow(sync.getSyncConfig()), resetPush);

  /* ---------------- B. pull：1500 条远端增量（逐条 applyRemote） ---------------- */
  const PULL = cfg.pull;
  const remoteRows = [];
  let ts = 1000;
  const orders = [];
  const lines = [];
  const orderCount = Math.floor(PULL * 0.4);
  const lineCount = PULL - orderCount;
  for (let i = 0; i < orderCount; i++) {
    const oid = `ro${i}`;
    const data = {
      id: oid, deviceId: 'dev2', operator: '老婆', createdAt: iso(Date.parse('2026-10-06T09:00:00+08:00') + i * 1000),
      payMethod: 'wechat', totalFen: 300, sessionId: 'rs0'
    };
    orders.push(data);
    remoteRows.push({ id: `order:${oid}`, record_id: oid, ledger: cfg.ledger, kind: 'order', data, updated_at: ts++, device_id: 'dev2', deleted: false });
  }
  for (let i = 0; i < lineCount; i++) {
    const lid = `rl${i}`;
    const data = {
      id: lid, orderId: `ro${i % orderCount}`, productId: 'p1', qtyBase: 1, unit: 'base', qty: 1,
      listUnitPriceFen: 200, unitPriceFen: 150, amountFen: 150, discountFen: 50
    };
    lines.push(data);
    remoteRows.push({ id: `line:${lid}`, record_id: lid, ledger: cfg.ledger, kind: 'line', data, updated_at: ts++, device_id: 'dev2', deleted: false });
  }

  const resetPull = async () => {
    await wipeLocal();
    localStorage.setItem('yh-sync-last-pull', '0');
  };

  const seedRemote = async () => {
    await remote('DELETE');
    for (let i = 0; i < remoteRows.length; i += 500) {
      await remote('POST', remoteRows.slice(i, i + 500));
    }
  };
  await seedRemote();
  await resetPull();
  out.pull1500 = await bench(cfg.n, () => sync.syncNow(sync.getSyncConfig()), resetPull);
  // 复核结果：再拉一次完整数据后统计本地落地行数
  await resetPull();
  await sync.syncNow(sync.getSyncConfig());
  out.pullResultCount = { orders: await db.orders.count(), lines: await db.lines.count() };

  // 记录一次同步产生的单条 IndexedDB 读写次数，作为 N+1 的证据
  const countOps = async (fn) => {
    const proto = Object.getPrototypeOf(db.orders);
    const origGet = proto.get, origPut = proto.put;
    let g = 0, p = 0;
    proto.get = function (...a) { g++; return origGet.apply(this, a); };
    proto.put = function (...a) { p++; return origPut.apply(this, a); };
    try { await fn(); } finally { proto.get = origGet; proto.put = origPut; }
    return { get: g, put: p };
  };
  await resetPush();
  out.pushOps = await countOps(() => sync.syncNow(sync.getSyncConfig()));
  await resetPull();
  out.pullOps = await countOps(() => sync.syncNow(sync.getSyncConfig()));

  await remote('DELETE');
  await wipeLocal();
  localStorage.setItem('yh-sync-disabled', '1');
  return { dataVolume: { pushOutbox: PUSH, pullRemote: PULL, pullOrders: orderCount, pullLines: lineCount }, results: out };
}
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="base")
    ap.add_argument("--pull", type=int, default=1500)
    ap.add_argument("--n", type=int, default=5)
    ap.add_argument("--out", default=r"E:\Temp\perf")
    args = ap.parse_args()

    cfg = {"remote": REMOTE, "ledger": LEDGER, "pull": args.pull, "n": args.n}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(locale="zh-CN", timezone_id="Asia/Shanghai")
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
    path = os.path.join(args.out, f"perf-sync-{args.label}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"label": args.label, "cfg": cfg, **payload}, f, ensure_ascii=False, indent=2)

    v = payload["dataVolume"]
    print(f"[{args.label}] push {v['pushOutbox']} 条；pull {v['pullRemote']} 条（{v['pullOrders']} 单 + {v['pullLines']} 行）")
    for name, s in payload["results"].items():
        if isinstance(s, dict) and "mean" in s:
            print(f"{name:<16}{s['mean']:>9.1f}{s['p50']:>9.1f}{s['p95']:>9.1f}{s['p99']:>9.1f}")
    print("pull 落地：", payload["results"].get("pullResultCount"))
    print("IDB 单条读写：push=%s pull=%s" % (payload["results"].get("pushOps"), payload["results"].get("pullOps")))
    print(f"\n结果 -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())