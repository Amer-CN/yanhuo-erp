"""报表页修复批次一（P0 + 结构性 P1）实测探针（2026-11-12）。

复用 scripts/report-audit-20261112/probe.py 的造数逻辑（同一套 SEED_JS +
scripts/ux-audit-20261112/plan.py），对新构建做回归：

  - 六种状态截图                 → docs/screenshots/report-fix-a/
  - 遮挡复测（5 个滚动位置，浮层 × 金额）
  - 卡头胶囊 rect / 44px / 与「补过 N 单」是否重叠
  - 四种状态的状态标签 innerText
  - 「复制本场汇总」到本场毛利值的距离
  - 成本全缺时汇总毛利 vs 表格毛利列
  - 触控目标 ≥44×44、按钮文字不折行、无横向溢出

云同步关闭、Supabase 请求全部 abort、Service Worker 屏蔽，测试数据不写真实账本。
输出：scripts/report-fix-a-20261112/result.json
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

ROOT = Path(r"F:\AIXM\烟花爆竹")
sys.path.insert(0, str(ROOT / "scripts" / "ux-audit-20261112"))
sys.path.insert(0, str(ROOT / "scripts" / "report-audit-20261112"))
from plan import build  # noqa: E402
from probe import SEED_JS, cross_device, empty_payload, one_session, order, without_open  # noqa: E402

BASE = "http://127.0.0.1:4173/"
SHOTS = ROOT / "docs" / "screenshots" / "report-fix-a"
OUT = ROOT / "scripts" / "report-fix-a-20261112"
SHOTS.mkdir(parents=True, exist_ok=True)

VIEW_W, VIEW_H = 390, 844
TODAY = datetime.now().strftime("%Y-%m-%d")

MEASURE_JS = """
() => {
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
    if (!a || !b) return { w: 0, h: 0, area: 0 };
    const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x));
    const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
    return { w: +w.toFixed(1), h: +h.toFixed(1), area: +(w * h).toFixed(1) };
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

  const all = (sel) => [...document.querySelectorAll(sel)];
  const one = (sel) => document.querySelector(sel);
  const main = one('.app-main');

  // ---- 状态标签（本场卡头胶囊）
  const pill = one('.report-session-switch');
  const pillRect = R(pill);
  const pillBadge = pill ? pill.querySelector('.glass-badge') : null;
  const patchedBadge = all('.report-session-head .glass-badge').find((e) => T(e).startsWith('补过'));

  // ---- 本场 hero（销售额 / 毛利）
  const summaryCard = all('.glass-page .glass-card, .page-stack > .glass-card')
    .find((c) => c.querySelector('.report-session-switch'));
  const heroes = summaryCard ? [...summaryCard.querySelectorAll('.stat--hero')].map((e) => ({
    k: T(e.querySelector('.k')), v: T(e.querySelector('.v')), vRect: R(e.querySelector('.v'))
  })) : [];

  // ---- 复制本场汇总按钮
  const copyBtn = all('.report-actions button').find((b) => T(b).includes('复制本场汇总'));
  const copyRect = R(copyBtn);
  const grossHero = heroes.find((h) => h.k.startsWith('毛利'));

  // ---- 本场卡里的操作条归属（必须在汇总卡，不在单品表）
  const actions = one('.report-actions');
  const actionsCard = actions ? actions.closest('.glass-card') : null;
  const tableCard = one('.glass-table') ? one('.glass-table').closest('.glass-card') : null;

  // ---- 表格
  const table = one('.glass-table');
  const tableInfo = table ? {
    rect: R(table),
    rows: [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => T(td))),
    headers: [...table.querySelectorAll('thead th')].map((th) => ({ text: T(th), rect: R(th) })),
    badges: [...table.querySelectorAll('.margin-flags .glass-badge')].map((b) => ({
      text: T(b), rect: R(b), lines: LINES(b)
    })),
    rowHeights: [...table.querySelectorAll('tbody tr')].map((tr, i) => ({ i, h: +tr.getBoundingClientRect().height.toFixed(1) })),
    footnote: one('.report-table-footnote') ? T(one('.report-table-footnote')) : null
  } : null;

  // ---- 浮层遮挡：所有 position:fixed 且可见的元素 × 金额节点
  const moneySel = '.stat--hero .v, .pay-row > span:last-child, .glass-table td.glass-table__num, .report-day-head__title';
  const money = all(moneySel).filter(VIS).map((e) => ({ text: T(e), rect: R(e), tag: e.tagName, cls: String(e.className) }));
  const fixed = all('body *').filter((e) => {
    if (!VIS(e)) return false;
    const s = getComputedStyle(e);
    // 浮动底栏是应用级导航（内容从其下方滚过，审计未把它算作遮挡），单独统计
    if (e.closest('.glass-tab-bar') || String(e.className).includes('glass-tab-bar')) return false;
    return s.position === 'fixed' && !e.closest('.glass-toast');
  }).map((e) => ({ cls: String(e.className), text: T(e).slice(0, 24), rect: R(e) }));
  const dock = all('body *').filter((e) => {
    if (!VIS(e)) return false;
    return String(e.className).includes('glass-tab-bar') && getComputedStyle(e).position === 'fixed';
  });
  const overlaps = [];
  for (const f of fixed) {
    for (const m of money) {
      const hit = INTER(f.rect, m.rect);
      if (hit.area > 0) overlaps.push({ fixed: f.cls || f.text, money: m.text, hit });
    }
  }
  let dockHitCount = 0;
  for (const f of dock) for (const m of money) if (INTER(R(f), m.rect).area > 0) dockHitCount++;

  // ---- 可点元素
  const nodes = all('button, a[href], [role="button"], .glass-tab-bar__item');
  const seen = new Set();
  const clickables = [];
  for (const e of nodes) {
    if (!VIS(e)) continue;
    const r = R(e);
    if (r.w <= 0 || r.h <= 0) continue;
    const text = T(e);
    const key = `${text}|${Math.round(r.x)},${Math.round(r.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clickables.push({ text, cls: String(e.className || ''), rect: r, smaller44: r.w < 44 || r.h < 44, lines: LINES(e) });
  }

  // ---- 溢出
  const wrap = one('.glass-table-wrap');
  return {
    scrollTop: main ? +main.scrollTop.toFixed(1) : null,
    pill: pill ? { text: T(pill), rect: pillRect, badge: pillBadge ? { text: T(pillBadge), cls: pillBadge.className, rect: R(pillBadge) } : null } : null,
    patchedBadge: patchedBadge ? { text: T(patchedBadge), rect: R(patchedBadge) } : null,
    pillVsPatched: pillRect && patchedBadge ? INTER(pillRect, R(patchedBadge)) : null,
    heroes,
    copy: copyBtn ? {
      rect: copyRect, text: T(copyBtn), disabled: !!copyBtn.disabled,
      inSummaryCard: !!(actionsCard && summaryCard && actionsCard === summaryCard),
      inTableCard: !!(actionsCard && tableCard && actionsCard === tableCard),
      gapToGross: copyRect && grossHero && grossHero.vRect ? +(copyRect.y - grossHero.vRect.bottom).toFixed(1) : null,
      actionsRect: R(actions)
    } : null,
    tableInfo,
    overlaps,
    dockHitCount,
    fixed,
    clickables,
    smallTargets: clickables.filter((c) => c.smaller44),
    wrappedButtons: clickables.filter((c) => c.lines > 1),
    overflow: {
      doc: { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth },
      main: main ? { sw: main.scrollWidth, cw: main.clientWidth } : null,
      wrap: wrap ? { sw: wrap.scrollWidth, cw: wrap.clientWidth, ox: getComputedStyle(wrap).overflowX } : null,
      table: table ? { sw: table.scrollWidth, cw: table.clientWidth, w: R(table).w } : null
    },
    innerText: main ? main.innerText : ''
  };
}
"""


def shot(page: Page, name: str) -> None:
    page.screenshot(path=str(SHOTS / f"{name}.png"))


def boot(page: Page) -> None:
    page.goto(BASE, wait_until="load")
    page.wait_for_selector(".glass-tab-bar__item", timeout=20000)
    page.wait_for_timeout(700)


def seed(page: Page, payload: dict) -> None:
    page.evaluate(SEED_JS, payload)
    page.reload(wait_until="load")
    page.wait_for_selector(".glass-tab-bar__item", timeout=20000)
    page.wait_for_timeout(900)


def goto_report(page: Page) -> None:
    page.locator(".glass-tab-bar__item", has_text="报表").first.tap()
    page.wait_for_selector(".page-stack", timeout=15000)
    page.wait_for_timeout(700)
    page.eval_on_selector(".app-main", "el => { el.scrollTop = 0; }")
    page.wait_for_timeout(250)


def make_payload() -> dict:
    payload, _ = build()
    if TODAY != "2026-11-12":
        payload = json.loads(json.dumps(payload, ensure_ascii=False).replace("2026-11-12", TODAY))
    return payload


def pick_history(page: Page, nth: int = 1) -> None:
    page.locator(".report-session-switch").tap()
    page.wait_for_selector(".glass-sheet", timeout=8000)
    page.wait_for_timeout(400)
    page.locator(".glass-sheet .glass-list__item").nth(nth).tap()
    page.wait_for_timeout(650)


def measure(page: Page, name: str, data: dict, scroll_fracs: tuple[float, ...] = ()) -> dict:
    item = {"layout": page.evaluate(MEASURE_JS)}
    shot(page, name)
    if scroll_fracs:
        item["scrollOverlap"] = []
        for frac in scroll_fracs:
            page.eval_on_selector(
                ".app-main",
                "(el, f) => { el.scrollTop = f * (el.scrollHeight - el.clientHeight); }",
                frac,
            )
            page.wait_for_timeout(280)
            item["scrollOverlap"].append({"frac": frac, **page.evaluate(
                """() => {
                  const R = (e) => { const r = e.getBoundingClientRect(); return { x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) }; };
                  const T = (e) => e ? (e.innerText || '').trim().replace(/\\s+/g, ' ') : '';
                  const VIS = (e) => { const r = e.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0; };
                  const INTER = (a, b) => +((Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x))) * (Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y)))).toFixed(1);
                  const main = document.querySelector('.app-main');
                  const fixed = [...document.querySelectorAll('body *')].filter((e) => VIS(e) && getComputedStyle(e).position === 'fixed' && !e.closest('.glass-tab-bar') && !String(e.className).includes('glass-tab-bar') && !e.closest('.glass-toast'));
                  const money = [...document.querySelectorAll('.stat--hero .v, .pay-row > span:last-child, .glass-table td.glass-table__num')].filter(VIS);
                  const hits = [];
                  for (const f of fixed) for (const m of money) {
                    const a = INTER(R(f), R(m));
                    if (a > 0) hits.push({ fixed: String(f.className), money: T(m), area: a });
                  }
                  return { scrollTop: +main.scrollTop.toFixed(1), fixedCount: fixed.length, hits };
                }"""
            )})
        page.eval_on_selector(".app-main", "el => { el.scrollTop = 0; }")
        page.wait_for_timeout(200)
    data[name] = item
    return item


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

        # +1 进行中（基准：今天已结账 S1 + 进行中 S2）
        seed(page, make_payload())
        goto_report(page)
        measure(page, "1-open-top", data, scroll_fracs=(0, 0.25, 0.5, 0.75, 1.0))
        page.eval_on_selector(".app-main", "el => { el.scrollTop = el.scrollHeight; }")
        page.wait_for_timeout(300)
        shot(page, "1b-open-bottom")

        # 已结账视图（8 行表）：遮挡复测 5 个滚动位置
        page.eval_on_selector(".app-main", "el => { el.scrollTop = 0; }")
        page.wait_for_timeout(200)
        pick_history(page, 1)
        measure(page, "2-closed-top", data, scroll_fracs=(0, 0.25, 0.5, 0.75, 1.0))
        page.eval_on_selector(".app-main", "el => { el.scrollTop = el.scrollHeight; }")
        page.wait_for_timeout(300)
        shot(page, "2b-closed-bottom")

        # 无进行中、有已结账（P0-1 的复发场景）
        seed(page, without_open(make_payload()))
        goto_report(page)
        measure(page, "3-no-open-top", data, scroll_fracs=(0, 0.25, 0.5, 0.75, 1.0))

        # 空账本（无场次）
        seed(page, empty_payload())
        goto_report(page)
        measure(page, "4-empty-top", data)
        page.eval_on_selector(".app-main", "el => { el.scrollTop = el.scrollHeight; }")
        page.wait_for_timeout(300)
        shot(page, "4b-empty-bottom")

        # 已结账无销售
        seed(page, one_session([], [], []))
        goto_report(page)
        measure(page, "5-closed-no-sales-top", data)
        page.locator(".glass-empty", has_text="这一场还没卖东西").scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        shot(page, "5b-closed-no-sales-bottom")

        # 全部删除
        vo, vl = order("v1", "10:00", "cash", "sample-2", 2, 150, 300, voided=True)
        vo2, vl2 = order("v2", "10:10", "wechat", "sample-5", 1, 300, 300, voided=True)
        seed(page, one_session([vo, vo2], [vl, vl2], []))
        goto_report(page)
        measure(page, "6-all-voided-top", data)
        page.locator(".glass-empty", has_text="这一场没有有效销售").scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        shot(page, "6b-all-voided-bottom")

        # 成本全缺
        o1, l1 = order("m1", "10:00", "cash", "sample-8", 1, 500, 500)
        seed(page, one_session([o1], [l1], []))
        goto_report(page)
        measure(page, "7-cost-missing-top", data)
        page.locator(".glass-table").scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        shot(page, "7b-cost-missing-table")

        # 对账不符（脏数据）：确认正常时没有「合计校验 ✓」、异常时红字与复制警告
        om, lm = order("x1", "10:00", "cash", "sample-2", 2, 150, "1000")
        seed(page, one_session([om], [lm], []))
        goto_report(page)
        item = measure(page, "8-pay-mismatch", data)
        item["copyText"] = None
        page.context.grant_permissions(["clipboard-read", "clipboard-write"])
        copy_btn = page.locator(".report-actions button").filter(has_text="复制本场汇总")
        if copy_btn.count() > 0:
            copy_btn.first.tap()
            page.wait_for_timeout(400)
            try:
                item["copyText"] = page.evaluate("() => navigator.clipboard.readText()")
            except Exception as exc:  # noqa: BLE001
                item["copyText"] = f"ERROR {exc}"

        browser.close()

    (OUT / "result.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"keys": list(data.keys()), "shots": len(list(SHOTS.glob('*.png')))},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()