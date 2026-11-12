"""报表页 UX 只读审计探针（2026-11-12）。

不改 src/**，只向浏览器 IndexedDB 造数据 + 读 DOM / 截图。
输出：
  docs/screenshots/report-audit-20261112/*.png
  scripts/report-audit-20261112/result.json

视口：390×844 / dsf=2 / is_mobile / has_touch / zh-CN / Asia-Shanghai。
云同步与 Supabase 请求全部拦截，测试数据不会写真实账本。
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

ROOT = Path(r"F:\AIXM\烟花爆竹")
sys.path.insert(0, str(ROOT / "scripts" / "ux-audit-20261112"))
from plan import build  # noqa: E402

BASE = "http://127.0.0.1:4173/"
SHOTS = ROOT / "docs" / "screenshots" / "report-audit-20261112"
OUT = ROOT / "scripts" / "report-audit-20261112"
SHOTS.mkdir(parents=True, exist_ok=True)

VIEW_W, VIEW_H = 390, 844
TODAY = datetime.now().strftime("%Y-%m-%d")

SEED_JS = """
async (payload) => {
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('yanhuo-erp');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const readTx = db.transaction(['settings'], 'readonly');
  const deviceId = (await req(readTx.objectStore('settings').get('deviceId')))?.value || 'audit-device';
  const fix = (o) => JSON.parse(JSON.stringify(o).replaceAll('__DEVICE__', deviceId));
  const tx = db.transaction(['orders', 'lines', 'sessions', 'batches', 'settings'], 'readwrite');
  for (const name of ['orders', 'lines', 'sessions', 'batches']) tx.objectStore(name).clear();
  for (const s of payload.sessions) tx.objectStore('sessions').put(fix(s));
  for (const o of payload.orders) tx.objectStore('orders').put(fix(o));
  for (const l of payload.lines) tx.objectStore('lines').put(fix(l));
  for (const b of payload.batches) tx.objectStore('batches').put(fix(b));
  tx.objectStore('settings').put({ key: 'sessionsMigrated', value: '1' });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close();
  return { deviceId, sessions: payload.sessions.length, orders: payload.orders.length };
}
"""

RECT = """
const R = (e) => {
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1),
           h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) };
};
const T = (e) => e ? (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ') : '';
const VIS = (e) => {
  if (!e) return false;
  const r = e.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const s = getComputedStyle(e);
  return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0;
};
const INTER = (a, b) => {
  if (!a || !b) return 0;
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
  return +(w * h).toFixed(1);
};
const LINES = (e) => {
  const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
  const tops = new Set();
  let n;
  while ((n = walker.nextNode())) {
    if (!n.textContent.trim()) continue;
    const rg = document.createRange();
    rg.selectNodeContents(n);
    for (const r of rg.getClientRects()) {
      if (r.width > 0 && r.height > 0) tops.add(Math.round(r.top));
    }
  }
  return tops.size;
};
"""

LAYOUT_JS = RECT + """
() => {
  const cardEls = [...document.querySelectorAll('.page-stack > *')];
  const cards = cardEls.map((e, i) => ({
    i, tag: e.tagName, cls: e.className, rect: R(e),
    head: T(e.querySelector('h2, .report-day-head__title')) || T(e).slice(0, 60)
  }));

  const one = (sel) => document.querySelector(sel);
  const all = (sel) => [...document.querySelectorAll(sel)];

  const hero = all('.stat--hero').map((e) => ({
    k: T(e.querySelector('.k')), v: T(e.querySelector('.v')),
    rect: R(e), vRect: R(e.querySelector('.v')), card: e.closest('.glass-card')?.className
  }));

  const pays = all('.pay-row').map((e) => ({
    text: T(e), rect: R(e), card: e.closest('.glass-card')?.className,
    spans: [...e.querySelectorAll('span')].map((s) => T(s))
  }));

  const stats = all('.stat-grid .stat').map((e) => ({
    text: T(e), rect: R(e), card: e.closest('.glass-card')?.className
  }));

  const excluded = all('.report-excluded').map((e) => ({
    text: T(e), rect: R(e),
    link: R(e.querySelector('.link-btn')), linkText: T(e.querySelector('.link-btn'))
  }));

  const notes = all('.report-note').map((e) => ({ text: T(e), rect: R(e) }));

  const statuses = all('.glass-status').map((e) => ({ text: T(e), rect: R(e) }));

  const actions = all('.report-actions').map((e) => ({
    rect: R(e),
    buttons: [...e.querySelectorAll('button')].map((b) => ({ text: T(b), rect: R(b), disabled: b.disabled }))
  }));

  const empties = all('.glass-empty').map((e) => ({
    text: T(e), rect: R(e),
    action: T(e.querySelector('.glass-empty__action button')),
    actionRect: R(e.querySelector('.glass-empty__action button'))
  }));

  const badges = all('.glass-badge').map((e) => ({ text: T(e), rect: R(e), cls: e.className }));
  const formHeads = all('.form-head h2').map((e) => ({ text: T(e), rect: R(e) }));

  const table = one('.glass-table');
  const tableInfo = table ? {
    rect: R(table),
    header: [...table.querySelectorAll('thead th')].map((th) => ({ text: T(th), rect: R(th) })),
    rows: table.querySelectorAll('tbody tr').length,
    rowsDetail: [...table.querySelectorAll('tbody tr')].slice(0, 20).map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => T(td))
    )
  } : null;

  const scope = all('.tiny-text').find((e) => T(e).startsWith('统计范围'));
  const range = one('.row-between .tiny-text');
  const fab = one('.report-session-fab');
  const tabbar = one('.glass-tab-bar-dock') || one('.glass-tab-bar');
  const gap = one('.report-session-fab-gap');
  const main = one('.app-main');

  const visibleTexts = [];
  const walker = document.createTreeWalker(one('.app-main'), NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent.trim();
    if (!t) continue;
    const p = n.parentElement;
    const r = R(p);
    if (!r || r.y < 0 || r.bottom > innerHeight) continue;
    if (r.w <= 0 || r.h <= 0) continue;
    visibleTexts.push({ t, y: r.y, x: r.x, cls: p.className, tag: p.tagName });
  }

  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    scroll: main ? { top: +main.scrollTop.toFixed(1), h: main.scrollHeight, ch: main.clientHeight } : null,
    cards, hero, pays, stats, excluded, notes, statuses, actions, empties, badges, formHeads,
    tableInfo,
    scope: scope ? { text: T(scope), rect: R(scope) } : null,
    range: range ? { text: T(range), rect: R(range) } : null,
    fab: fab ? { text: T(fab), label: fab.getAttribute('aria-label'), rect: R(fab) } : null,
    fabGap: gap ? { rect: R(gap), h: getComputedStyle(gap).height } : null,
    tabbar: tabbar ? { rect: R(tabbar), cls: tabbar.className } : null,
    pageInnerText: one('.app-main')?.innerText || '',
    visibleTexts
  };
}
"""

CLICK_JS = RECT + """
() => {
  const nodes = [...document.querySelectorAll('button, a[href], [role="button"], input[type="checkbox"], .glass-tab-bar__item')];
  const out = [];
  const seen = new Set();
  for (const e of nodes) {
    if (!VIS(e)) continue;
    const r = R(e);
    if (r.w <= 0 || r.h <= 0) continue;
    const isTab = e.closest('.glass-tab-bar');
    const text = T(e);
    const key = `${text}|${e.tagName}|${Math.round(r.x)},${Math.round(r.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      text, tag: e.tagName, cls: String(e.className || ''),
      aria: e.getAttribute('aria-label'), title: e.getAttribute('title'),
      disabled: !!e.disabled, isTab: !!isTab, rect: r,
      inViewport: r.bottom > 0 && r.y < innerHeight,
      smaller44: r.w < 44 || r.h < 44,
      lines: LINES(e), scrollOverflow: e.scrollWidth > e.clientWidth + 1
    });
  }
  return out;
}
"""

FONT_JS = RECT + """
() => {
  const out = [];
  const seen = new Set();
  for (const e of document.querySelectorAll('.app-main *, .glass-tab-bar *')) {
    if (!VIS(e)) continue;
    const direct = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!direct) continue;
    const fs = parseFloat(getComputedStyle(e).fontSize);
    if (!(fs < 12)) continue;
    const t = T(e);
    if (!t) continue;
    const r = R(e);
    const key = `${fs}|${t}|${e.className}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ fs, text: t.slice(0, 40), cls: String(e.className || ''), rect: r });
  }
  return out.sort((a, b) => a.fs - b.fs);
}
"""

OVERFLOW_JS = RECT + """
() => {
  const m = document.querySelector('.app-main');
  const wrap = document.querySelector('.glass-table-wrap');
  const table = document.querySelector('.glass-table');
  const cards = [...document.querySelectorAll('.glass-card')].map((e) => R(e));
  return {
    doc: { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth },
    body: { sw: document.body.scrollWidth, cw: document.body.clientWidth },
    main: m ? { sw: m.scrollWidth, cw: m.clientWidth, ox: getComputedStyle(m).overflowX } : null,
    wrap: wrap ? { sw: wrap.scrollWidth, cw: wrap.clientWidth, ox: getComputedStyle(wrap).overflowX } : null,
    table: table ? { sw: table.scrollWidth, cw: table.clientWidth, w: R(table).w } : null,
    cards,
    hasHScrollbar: m ? m.scrollWidth > m.clientWidth + 1 : false
  };
}
"""

OVERLAP_JS = RECT + """
() => {
  const main = document.querySelector('.app-main');
  const fab = document.querySelector('.report-session-fab');
  const table = document.querySelector('.glass-table');
  const tabbar = document.querySelector('.glass-tab-bar-dock') || document.querySelector('.glass-tab-bar');
  const gap = document.querySelector('.report-session-fab-gap');
  if (!main || !table) return { ok: false };
  const fr = R(fab);
  const rows = [...table.querySelectorAll('tbody tr')].map((tr, idx) => {
    const tds = [...tr.querySelectorAll('td')];
    const last = tds[tds.length - 1];
    const prev = tds[tds.length - 2];
    return {
      idx,
      name: T(tds[0]),
      lastText: T(last), lastRect: R(last), lastHit: INTER(fr, R(last)),
      prevText: T(prev), prevRect: R(prev), prevHit: INTER(fr, R(prev))
    };
  });
  const ths = [...table.querySelectorAll('thead th')];
  const lastTh = ths[ths.length - 1];
  return {
    ok: true,
    scrollTop: +main.scrollTop.toFixed(1),
    maxScroll: main.scrollHeight - main.clientHeight,
    fab: fr,
    fabText: T(fab),
    table: R(table),
    firstTh: R(ths[0]),
    lastTh: { text: T(lastTh), rect: R(lastTh), hit: INTER(fr, R(lastTh)) },
    tabbar: R(tabbar),
    gap: gap ? { rect: R(gap), h: getComputedStyle(gap).height } : null,
    rows,
    hits: rows.filter((r) => r.lastHit > 0 || r.prevHit > 0),
    tabbarGap: tabbar && fr ? +(R(tabbar).y - fr.bottom).toFixed(1) : null
  };
}
"""

TERMS_JS = RECT + """
(terms) => {
  const main = document.querySelector('.app-main');
  const nodes = [];
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent.trim();
    if (!t) continue;
    const hits = terms.filter((w) => t.includes(w));
    if (!hits.length) continue;
    const p = n.parentElement;
    nodes.push({ text: t.slice(0, 60), terms: hits, cls: String(p.className || ''), y: +p.getBoundingClientRect().top.toFixed(1) });
  }
  return { counts: Object.fromEntries(terms.map((w) => [w, (main.innerText.match(new RegExp(w, 'g')) || []).length])), nodes };
}
"""

TERMS = ["这一场", "本场", "今天", "当日", "场次", "历史", "已结账", "收摊", "进行中", "补记", "删除"]


def shot(page: Page, name: str) -> str:
    p = SHOTS / f"{name}.png"
    page.screenshot(path=str(p))
    return str(p)


def save(name: str, data) -> None:
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def boot(page: Page) -> None:
    page.goto(BASE, wait_until="load")
    page.wait_for_selector(".glass-tab-bar__item", timeout=20000)
    page.wait_for_timeout(700)


def seed(page: Page, payload: dict) -> dict:
    info = page.evaluate(SEED_JS, payload)
    page.reload(wait_until="load")
    page.wait_for_selector(".glass-tab-bar__item", timeout=20000)
    page.wait_for_timeout(900)
    return info


def goto_report(page: Page) -> None:
    if page.locator(".glass-tab-bar__item").count() == 0 and page.locator(".back-btn").count() > 0:
        page.locator(".back-btn").first.tap()
        page.wait_for_timeout(400)
    page.locator(".glass-tab-bar__item", has_text="报表").first.tap()
    page.wait_for_selector(".page-stack", timeout=15000)
    page.wait_for_timeout(700)
    page.eval_on_selector(".app-main", "el => { el.scrollTop = 0; }")
    page.wait_for_timeout(200)


def open_picker(page: Page) -> None:
    page.locator(".report-session-fab").tap()
    page.wait_for_selector(".glass-sheet", timeout=8000)
    page.wait_for_timeout(450)


def choose_closed(page: Page, nth: int = 1) -> None:
    open_picker(page)
    items = page.locator(".glass-sheet .glass-list__item")
    items.nth(nth).tap()
    page.wait_for_timeout(650)


def snap(page: Page, name: str, data: dict | None = None) -> dict:
    lay = page.evaluate(LAYOUT_JS)
    clk = page.evaluate(CLICK_JS)
    font = page.evaluate(FONT_JS)
    ovf = page.evaluate(OVERFLOW_JS)
    terms = page.evaluate(TERMS_JS, TERMS)
    item = {"layout": lay, "clickables": clk, "smallFonts": font, "overflow": ovf, "terms": terms,
            "shot": shot(page, name)}
    if data is not None:
        data[name] = item
    return item


def make_payload() -> dict:
    payload, _ = build()
    # 日期跟随本机今天（plan 固定 2026-11-12，与当前环境一致；若不一致则平移）
    if TODAY != "2026-11-12":
        raw = json.dumps(payload, ensure_ascii=False).replace("2026-11-12", TODAY)
        payload = json.loads(raw)
    return payload


def without_open(payload: dict) -> dict:
    p = json.loads(json.dumps(payload, ensure_ascii=False))
    p["sessions"] = [s for s in p["sessions"] if s["status"] != "open"]
    ids = {s["id"] for s in p["sessions"]}
    p["orders"] = [o for o in p["orders"] if o["sessionId"] in ids]
    p["lines"] = [l for l in p["lines"] if any(o["id"] == l["orderId"] for o in p["orders"])]
    return p


def empty_payload() -> dict:
    return {"sessions": [], "orders": [], "lines": [], "batches": []}


def one_session(orders: list, lines: list, batches: list, status: str = "closed") -> dict:
    return {
        "sessions": [{
            "id": "s-only", "deviceId": "__DEVICE__",
            "startedAt": f"{TODAY}T09:00:00",
            "closedAt": f"{TODAY}T12:00:00" if status == "closed" else None,
            "status": status, "openedBy": "我", "closedBy": "我",
            "patchedCount": 0, "updatedAt": f"{TODAY}T12:00:00",
        }],
        "orders": orders, "lines": lines, "batches": batches
    }


def order(oid: str, hhmm: str, pay: str, pid: str, qty: int, price: int, total: int | str,
          voided: bool = False, gift: bool = False) -> tuple[dict, dict]:
    created = f"{TODAY}T{hhmm}:00"
    o = {"id": oid, "deviceId": "__DEVICE__", "operator": "我", "createdAt": created,
         "payMethod": pay, "totalFen": total, "sessionId": "s-only", "voided": voided,
         "updatedAt": created}
    ln = {"id": f"{oid}-l1", "orderId": oid, "productId": pid, "qtyBase": qty,
          "unit": "base", "qty": qty, "listUnitPriceFen": price, "unitPriceFen": price,
          "amountFen": 0 if gift else qty * price, "discountFen": 0,
          "updatedAt": created}
    if gift:
        ln["gift"] = True
    return o, ln


def cross_device(payload: dict) -> dict:
    p = json.loads(json.dumps(payload, ensure_ascii=False))
    # 另一台手机的一整场：同一天已结账
    p["sessions"].append({
        "id": "session-other", "deviceId": "other-device",
        "startedAt": f"{TODAY}T08:00:00", "closedAt": f"{TODAY}T10:00:00",
        "status": "closed", "openedBy": "老婆", "closedBy": "老婆",
        "patchedCount": 0, "updatedAt": f"{TODAY}T10:00:00",
    })
    oid = "o-other-1"
    p["orders"].append({"id": oid, "deviceId": "other-device", "operator": "老婆",
                        "createdAt": f"{TODAY}T08:30:00", "payMethod": "cash",
                        "totalFen": 5000, "sessionId": "session-other", "voided": False,
                        "updatedAt": f"{TODAY}T08:30:00"})
    p["lines"].append({"id": f"{oid}-l1", "orderId": oid, "productId": "sample-8",
                       "qtyBase": 10, "unit": "base", "qty": 10, "listUnitPriceFen": 500,
                       "unitPriceFen": 500, "amountFen": 5000, "discountFen": 0,
                       "updatedAt": f"{TODAY}T08:30:00"})
    return p


def main() -> None:
    data: dict = {"meta": {"date": TODAY, "viewport": [VIEW_W, VIEW_H]}}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": VIEW_W, "height": VIEW_H}, device_scale_factor=2,
            is_mobile=True, has_touch=True, locale="zh-CN", timezone_id="Asia/Shanghai",
            service_workers="block",
            user_agent=("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
        )
        ctx.add_init_script("try{localStorage.setItem('yh-sync-disabled','1')}catch(e){}")
        page = ctx.new_page()
        page.route("**/rest/v1/**", lambda r: r.abort())
        page.route("**/auth/v1/**", lambda r: r.abort())
        boot(page)

        # ---------------------------------------------------- A. 主场景（今天已结账 S1 + 进行中 S2）
        info = seed(page, make_payload())
        data["meta"]["seed"] = info
        goto_report(page)
        data["A_current_top"] = snap(page, "01-current-top", data)
        data["A_current_overlap"] = []

        # 首屏当前视图：记录 5 个滚动位置的遮挡
        for frac in (0, 0.25, 0.5, 0.75, 1.0):
            page.eval_on_selector(".app-main", "(el, f) => { el.scrollTop = f * (el.scrollHeight - el.clientHeight); }", frac)
            page.wait_for_timeout(250)
            data["A_current_overlap"].append({"frac": frac, **page.evaluate(OVERLAP_JS)})
            shot(page, f"02-current-scroll-{int(frac * 100):03d}")

        # 切到已结账 S1
        page.eval_on_selector(".app-main", "el => { el.scrollTop = 0; }")
        page.wait_for_timeout(200)
        open_picker(page)
        shot(page, "03-picker-sheet")
        data["A_picker_text"] = page.locator(".glass-sheet").inner_text()
        page.locator(".glass-sheet .glass-list__item").nth(1).tap()
        page.wait_for_timeout(700)
        data["A_history_top"] = snap(page, "04-history-s1-top", data)
        data["A_history_overlap"] = []
        for frac in (0, 0.25, 0.5, 0.75, 1.0):
            page.eval_on_selector(".app-main", "(el, f) => { el.scrollTop = f * (el.scrollHeight - el.clientHeight); }", frac)
            page.wait_for_timeout(250)
            data["A_history_overlap"].append({"frac": frac, **page.evaluate(OVERLAP_JS)})
            shot(page, f"05-history-scroll-{int(frac * 100):03d}")

        # 删除单弹层（今天 / 本场）
        page.eval_on_selector(".app-main", "el => { el.scrollTop = 0; }")
        page.wait_for_timeout(250)
        links = page.locator(".report-excluded .link-btn")
        if links.count() > 0:
            links.first.tap()
            page.wait_for_selector(".glass-sheet", timeout=8000)
            page.wait_for_timeout(450)
            shot(page, "06-voided-sheet-first")
            data["A_voided_sheet_first"] = page.locator(".glass-sheet").inner_text()
            page.locator(".glass-sheet__close").first.tap()
            page.wait_for_timeout(300)
        if links.count() > 1:
            links.nth(1).tap()
            page.wait_for_selector(".glass-sheet", timeout=8000)
            page.wait_for_timeout(450)
            shot(page, "07-voided-sheet-second")
            data["A_voided_sheet_second"] = page.locator(".glass-sheet").inner_text()
            page.locator(".glass-sheet__close").first.tap()
            page.wait_for_timeout(300)

        # ------------------------------------------------ B. 有已结账、无进行中：顶部标签是否说谎
        seed(page, without_open(make_payload()))
        goto_report(page)
        data["B_no_open"] = snap(page, "08-no-open-has-closed", data)

        # ------------------------------------------------ C. 空账本
        seed(page, empty_payload())
        goto_report(page)
        data["C_empty"] = snap(page, "09-empty-ledger", data)
        page.eval_on_selector(".app-main", "el => { el.scrollTop = el.scrollHeight; }")
        page.wait_for_timeout(300)
        shot(page, "09b-empty-ledger-bottom")

        # ------------------------------------------------ D. 有场次无销售（已结账）
        seed(page, one_session([], [], []))
        goto_report(page)
        data["D_no_sales"] = snap(page, "10-closed-no-sales", data)
        page.locator(".glass-empty", has_text="这一场还没卖东西").scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        shot(page, "10b-closed-no-sales-bottom")

        # ------------------------------------------------ E. 全部删除
        vo, vl = order("v1", "10:00", "cash", "sample-2", 2, 150, 300, voided=True)
        vo2, vl2 = order("v2", "10:10", "wechat", "sample-5", 1, 300, 300, voided=True)
        seed(page, one_session([vo, vo2], [vl, vl2], []))
        goto_report(page)
        data["E_all_voided"] = snap(page, "11-all-voided", data)
        page.locator(".glass-empty", has_text="这一场没有有效销售").scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        shot(page, "11b-all-voided-bottom")
        links = page.locator(".report-excluded .link-btn")
        if links.count() > 0:
            links.first.tap()
            page.wait_for_selector(".glass-sheet", timeout=8000)
            page.wait_for_timeout(400)
            shot(page, "12-all-voided-sheet")
            page.locator(".glass-sheet__close").first.tap()

        # ------------------------------------------------ F. 成本全缺（有销量、无批次）
        o1, l1 = order("m1", "10:00", "cash", "sample-8", 1, 500, 500)
        seed(page, one_session([o1], [l1], []))
        goto_report(page)
        data["F_cost_missing"] = snap(page, "13-cost-missing-all", data)
        page.locator(".glass-table").scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        shot(page, "13b-cost-missing-table")

        # ------------------------------------------------ G. 临期为空（批次 2099 年到期）
        o2, l2 = order("g1", "10:00", "cash", "sample-2", 2, 150, 300)
        b = {"id": "b-far", "productId": "sample-2", "qtyBase": 100, "unitCostFen": 80,
             "supplier": "送货单", "receivedAt": TODAY, "expiryDate": "2099-01-01",
             "deviceId": "__DEVICE__", "createdAt": f"{TODAY}T07:00:00",
             "updatedAt": f"{TODAY}T07:00:00"}
        seed(page, one_session([o2], [l2], [b]))
        goto_report(page)
        data["G_expiry_empty"] = snap(page, "14-expiry-empty", data)
        page.locator(".glass-empty", has_text="没有临期批次").scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        shot(page, "14b-expiry-empty-bottom")

        # ------------------------------------------------ H. 对账不符（模拟脏数据：totalFen 字符串）
        om, lm = order("x1", "10:00", "cash", "sample-2", 2, 150, "1000")
        seed(page, one_session([om], [lm], []))
        goto_report(page)
        data["H_mismatch_simulated"] = snap(page, "15-pay-mismatch-simulated", data)
        page.locator(".glass-status").first.scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        shot(page, "15b-pay-mismatch-status")

        # ------------------------------------------------ I. 双设备：今天合计跨设备，场次列表只本机
        seed(page, cross_device(make_payload()))
        goto_report(page)
        data["I_cross_device_top"] = snap(page, "16-cross-device-top", data)
        open_picker(page)
        shot(page, "17-cross-device-picker")
        data["I_picker_text"] = page.locator(".glass-sheet").inner_text()
        page.locator(".glass-sheet__close").first.tap()

        browser.close()

    save("result.json", data)
    print(json.dumps({
        "shots": len(list(SHOTS.glob("*.png"))),
        "keys": list(data.keys()),
        "today": TODAY,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()