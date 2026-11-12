"""进货页「保存这一条」底栏（.record-actions--above-dock）位置实测。

背景：它从 fixed（bottom = 胶囊离底 16 + 74 + safe-area）改成 `.app-main` 里的
`position: sticky; bottom: 0`。sticky 的语义是「不许滚出滚动视口下沿」，
**不是**「永远贴在视口下沿」——只有当元素静止位置在视口下方时才会被顶上来。
所以必须分两段量：
  A. 内容比一屏短（页面没得滚）：它停在静止位置，容易悬在屏幕中间；
  B. 内容超一屏（展开「批次信息」）：它应该吸在滚动视口下沿，滚到底才回落。
本脚本把两种情形、5 个滚动位置都记下来，供判断是否算回归。

用法（先 pnpm dev）：
    python scripts/dock-belt-20261112/probe_purchase_bar.py
"""

from __future__ import annotations

import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import Page, sync_playwright

BASE = os.environ.get("AUDIT_BASE", "http://127.0.0.1:5173/")
OUT = os.path.join(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")),
                   "docs", "screenshots", "dock-belt")

JS = r"""
(ratio) => {
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1),
             top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), left: +b.left.toFixed(1), right: +b.right.toFixed(1) };
  };
  const main = document.querySelector('.app-main');
  const max = Math.max(0, main.scrollHeight - main.clientHeight);
  main.scrollTop = Math.round(max * ratio);

  const bar = document.querySelector('.record-actions--above-dock');
  const dock = document.querySelector('.glass-tab-bar-dock');
  const capsule = document.querySelector('.glass-tab-bar');
  const br = r(bar), dr = r(dock), cr = r(capsule);
  const inter = (a, b) => {
    if (!a || !b) return null;
    const iw = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const ih = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return iw > 0 && ih > 0 ? +(iw * ih).toFixed(1) : 0;
  };
  // 底栏里最后一张卡（.glass-list）的底边，用来判断「最后一行是否完整可见」
  const lists = [...document.querySelectorAll('.app-main .glass-list')];
  const lastCard = lists[lists.length - 1];
  const lr = r(lastCard);
  const cs = getComputedStyle(bar);

  // 动作栏是否盖住了可见内容（叶子节点口径）
  let coverN = 0, coverA = 0;
  if (br) {
    for (const el of main.querySelectorAll('*')) {
      if (el.closest('.record-actions, .glass-tab-bar-dock')) continue;
      if (el.children.length) continue;
      const rr = el.getBoundingClientRect();
      if (rr.width < 2 || rr.height < 2) continue;
      const iw = Math.min(br.right, rr.right) - Math.max(br.left, rr.left);
      const ih = Math.min(br.bottom, Math.min(rr.bottom, main.getBoundingClientRect().bottom)) - Math.max(br.top, rr.top);
      if (iw > 0 && ih > 0) { coverN += 1; coverA += iw * ih; }
    }
  }

  return {
    ratio,
    scrollTop: main.scrollTop, max,
    mainRect: r(main),
    bar: br,
    barPosition: cs.position,
    barMarginTop: cs.marginTop,
    dock: dr, capsule: cr,
    lastCard: lr,
    gapBarToDock: br && dr ? +(dr.top - br.bottom).toFixed(1) : null,
    barVsDock: inter(br, dr),
    barVsCapsule: inter(br, cr),
    lastCardVsBar: inter(lr, br),
    lastCardBottom: lr ? lr.bottom : null,
    lastCardVisible: lr ? lr.bottom <= main.getBoundingClientRect().bottom + 0.5 : null,
    coverN, coverA: +coverA.toFixed(1),
    docW: document.documentElement.scrollWidth, docCw: document.documentElement.clientWidth,
  };
}
"""


def shot(page: Page, name: str) -> None:
    page.screenshot(path=os.path.join(OUT, name))
    print(f"    screenshot -> docs/screenshots/dock-belt/{name}")


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    result: dict = {}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                                  locale="zh-CN", timezone_id="Asia/Shanghai")
        page = ctx.new_page()
        ctx.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
        page.goto(BASE, wait_until="networkidle")
        page.get_by_role("button", name="进货").first.wait_for(timeout=25000)
        page.get_by_role("button", name="进货").first.click()
        page.wait_for_timeout(900)

        # A. 内容比一屏短（未展开批次信息）
        result["short"] = [page.evaluate(JS, r) for r in (0, 0.25, 0.5, 0.75, 1.0)]
        for m in result["short"]:
            print(f"[短] {int(m['ratio']*100):>3}% bar={m['bar']['y']}..{m['bar']['bottom']} "
                  f"距底栏={m['gapBarToDock']} barVsDock={m['barVsDock']} max={m['max']}")
        shot(page, "probe-purchase-short.png")

        # B. 展开「批次信息」，让页面真的超一屏
        det = page.locator(".app-main details")
        if det.count():
            det.first.evaluate("(el) => { el.open = true; }")
            page.wait_for_timeout(500)
        result["long"] = [page.evaluate(JS, r) for r in (0, 0.25, 0.5, 0.75, 1.0)]
        for m in result["long"]:
            print(f"[长] {int(m['ratio']*100):>3}% bar={m['bar']['y']}..{m['bar']['bottom']} "
                  f"距底栏={m['gapBarToDock']} barVsDock={m['barVsDock']} 盖内容={m['coverN']}处/{m['coverA']}px² "
                  f"末卡可见={m['lastCardVisible']} max={m['max']}")
        page.evaluate(JS, 0)
        page.wait_for_timeout(300)
        shot(page, "probe-purchase-long-top.png")
        page.evaluate(JS, 1.0)
        page.wait_for_timeout(300)
        shot(page, "probe-purchase-long-bottom.png")

        browser.close()

    path = os.path.join(os.path.dirname(__file__), "result-purchase-bar.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"\n结果 -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())