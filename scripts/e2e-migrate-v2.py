"""历史数据迁移验证：旧订单（无 sessionId）→ 自动聚合场次，金额不变且幂等。

需先 pnpm build + pnpm preview -- --port 4173。默认禁用云同步。
"""

import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ.get("YH_BASE", "http://localhost:4173/")
SHOT_DIR = Path(os.environ.get("YH_SHOTS", r"E:\Temp\yh-v2"))
SHOT_DIR.mkdir(parents=True, exist_ok=True)

SEED_OLD = """async () => {
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('yanhuo-erp');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = db.transaction(['orders', 'lines', 'settings', 'sessions'], 'readwrite');
  const settings = tx.objectStore('settings');
  const deviceId = (await req(settings.get('deviceId')))?.value || 'e2e-device';

  const mkLine = (id, orderId, qty, list, amount) => ({
    id, orderId, productId: 'sample-1', qtyBase: qty, unit: 'base', qty,
    listUnitPriceFen: list, unitPriceFen: Math.round(amount / qty), amountFen: amount,
    discountFen: Math.max(0, list * qty - amount)
  });

  const orders = [
    { id: 'old-1', deviceId, operator: '我', createdAt: '2026-01-01T10:00:00', payMethod: 'cash', totalFen: 3000 },
    { id: 'old-2', deviceId, operator: '老婆', createdAt: '2026-01-01T11:00:00', payMethod: 'wechat', totalFen: 2000 },
    { id: 'old-3', deviceId, operator: '我', createdAt: '2026-01-02T19:00:00', payMethod: 'cash', totalFen: 5000 }
  ];
  const lines = [
    mkLine('old-l1', 'old-1', 1, 3000, 3000),
    mkLine('old-l2', 'old-2', 1, 2000, 2000),
    mkLine('old-l3', 'old-3', 1, 5000, 5000)
  ];
  const os = tx.objectStore('orders');
  for (const o of orders) os.put(o);
  const ls = tx.objectStore('lines');
  for (const l of lines) ls.put(l);
  settings.delete('sessionsMigrated');
  tx.objectStore('sessions').clear();
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close();
  return orders.length;
}"""

READ_STATE = """async () => {
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('yanhuo-erp');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = db.transaction(['sessions', 'orders'], 'readonly');
  const sessions = await req(tx.objectStore('sessions').getAll());
  const orders = await req(tx.objectStore('orders').getAll());
  db.close();
  return {
    sessions: sessions.map((s) => ({
      orderCount: s.summary?.orderCount ?? 0,
      revenue: s.summary?.revenueFen ?? 0,
      startedAt: s.startedAt,
      status: s.status
    })),
    totalOrders: orders.length,
    unassigned: orders.filter((o) => !o.sessionId).length,
    revenue: orders.filter((o) => !o.voided).reduce((s, o) => s + o.totalFen, 0)
  };
}"""


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={"width": 390, "height": 844})
        context.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
        page = context.new_page()
        page.goto(BASE, wait_until="domcontentloaded")
        page.get_by_role("button", name="记一笔").first.wait_for(timeout=25000)

        count = page.evaluate(SEED_OLD)
        print(f"写入旧订单 {count} 条（无 sessionId）")

        page.reload(wait_until="domcontentloaded")
        page.get_by_role("button", name="记一笔").first.wait_for(timeout=25000)
        page.wait_for_timeout(800)

        state = page.evaluate(READ_STATE)
        print("迁移后：", state)
        assert state["totalOrders"] == 3, state
        assert state["unassigned"] == 0, "仍有订单没挂到场次"
        assert len(state["sessions"]) == 2, f"期望 2 个场次，实际 {len(state['sessions'])}"
        assert sum(s["revenue"] for s in state["sessions"]) == 10000, "迁移前后销售额不一致"

        # 跳报表确认可读
        page.get_by_role("button", name="报表").click()
        page.get_by_text("销售额", exact=False).first.wait_for(timeout=8000)
        page.screenshot(path=str(SHOT_DIR / "11-migrated-report.png"))

        # 幂等：刷新后不新增场次
        page.reload(wait_until="domcontentloaded")
        page.get_by_role("button", name="记账").first.wait_for(timeout=25000)
        page.wait_for_timeout(600)
        again = page.evaluate(READ_STATE)
        assert len(again["sessions"]) == 2, f"重复执行产生了新场次：{again}"
        print("重复执行后：", again)

        print("OK：历史数据迁移金额一致、重复执行幂等")
        browser.close()
        return 0


if __name__ == "__main__":
    sys.exit(main())