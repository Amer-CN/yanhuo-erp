"""临时调试：打印 报表 / 库存 页的真实几何。"""
from __future__ import annotations

import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright

BASE = os.environ.get("AUDIT_BASE", "http://127.0.0.1:5173/")

JS = r"""
() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { x:+b.x.toFixed(1), y:+b.y.toFixed(1), w:+b.width.toFixed(1), h:+b.height.toFixed(1), bottom:+b.bottom.toFixed(1) }; };
  const shell = document.querySelector('.app-shell');
  const main = document.querySelector('.app-main');
  const bar = document.querySelector('.glass-tab-bar');
  const dock = document.querySelector('.glass-tab-bar-dock');
  const cs = getComputedStyle(shell);
  const mcs = getComputedStyle(main);
  const kids = [...shell.children].map(el => ({ cls: (el.className||el.tagName).toString().slice(0,40), pos: getComputedStyle(el).position, rect: r(el) }));
  return {
    shell: r(shell), shellRows: cs.gridTemplateRows, shellH: cs.height, shellOverflow: cs.overflow,
    main: r(main), mainOverflow: mcs.overflowY, mainPadBottom: mcs.paddingBottom,
    mainScroll: { sh: main.scrollHeight, ch: main.clientHeight },
    bar: r(bar), dock: r(dock),
    kids,
    scrollers: [...document.querySelectorAll('*')].filter(e => e.scrollHeight - e.clientHeight > 4 && getComputedStyle(e).overflowY !== 'visible')
      .map(e => ({ cls: (e.className||e.tagName).toString().slice(0,40), rect: r(e), sh: e.scrollHeight, ch: e.clientHeight })),
  };
}
"""


def main() -> int:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, locale="zh-CN")
        page = ctx.new_page()
        ctx.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
        page.goto(BASE, wait_until="networkidle")
        page.get_by_role("button", name="记一笔").last.wait_for(timeout=25000)
        for tab in ("报表", "库存", "记账"):
            page.get_by_role("button", name=tab, exact=True).first.click()
            page.wait_for_timeout(800)
            print(f"\n=== {tab} ===")
            print(json.dumps(page.evaluate(JS), ensure_ascii=False, indent=1))
        b.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())