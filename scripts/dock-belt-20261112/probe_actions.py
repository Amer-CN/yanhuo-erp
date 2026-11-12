"""排查 `.record-actions`（底部动作栏）到底出现在什么场景（2026-11-12）。

背景：`.record-actions` 仍是 `position: fixed; left:50%; transform:translateX(-50%); bottom:0`。
底栏改成 `.app-shell` 网格第 4 行之后，需要确认它会不会和第 4 行叠在一起。

做法（只用真实 DOM 证据，不靠读代码猜）：
1. 打开「记一笔」整页编辑视图，量 `.record-actions` 的 rect、它所在的滚动上下文、
   `.glass-tab-bar` / `.glass-tab-bar-dock` 是否存在、各自 rect 与 z-index；
2. 若两者同时存在，算相交面积并做 elementFromPoint 采样（判定谁盖谁）；
3. 再进「进货」页（它是 `.record-actions--above-dock`），同样量一遍；
4. 顺带量一次 Sheet（例如关闭场次）里有没有 `.record-actions`——历史上它是
   「全屏弹层内」的候选场景，这里用 DOM 计数给结论。

用法（先 pnpm dev）：
    python scripts/dock-belt-20261112/probe_actions.py
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

PROBE = r"""
() => {
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1),
             top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), left: +b.left.toFixed(1), right: +b.right.toFixed(1) };
  };
  const inter = (a, b) => {
    if (!a || !b) return null;
    const iw = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const ih = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return iw > 0 && ih > 0 ? +(iw * ih).toFixed(1) : 0;
  };
  // 最近一个「真的会滚」的祖先（overflow 非 visible 且能滚）
  const scrollerOf = (el) => {
    let p = el.parentElement;
    while (p && p !== document.documentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll|hidden)/.test(cs.overflowY)) {
        return { cls: (p.className || p.tagName).toString().slice(0, 48), rect: r(p),
                 sh: p.scrollHeight, ch: p.clientHeight, oy: cs.overflowY };
      }
      p = p.parentElement;
    }
    return { cls: 'document', rect: null, sh: document.documentElement.scrollHeight,
             ch: window.innerHeight, oy: 'visible' };
  };

  const acts = [...document.querySelectorAll('.record-actions')];
  const bar = document.querySelector('.glass-tab-bar');
  const dock = document.querySelector('.glass-tab-bar-dock');
  const shell = document.querySelector('.app-shell');
  const main = document.querySelector('.app-main');

  const info = acts.map((el) => {
    const cs = getComputedStyle(el);
    const rect = r(el);
    const sc = scrollerOf(el);
    // 动作栏里最高层元素的命中测试：中心 3 点
    const hits = [];
    for (const fx of (acts.length > 1 ? [0.2, 0.5, 0.8] : [0.1, 0.5, 0.9])) {
      const x = rect.left + rect.w * fx;
      const y = rect.top + rect.h / 2;
      const hit = document.elementFromPoint(x, y);
      hits.push({ x: Math.round(x), y: Math.round(y),
                  hit: hit ? ((hit.className || hit.tagName).toString().slice(0, 42)) : null,
                  inside: !!(hit && hit.closest('.record-actions')) });
    }
    return {
      cls: el.className,
      rect,
      position: cs.position,
      bottom: cs.bottom,
      zIndex: cs.zIndex,
      width: cs.width,
      transform: cs.transform,
      left: cs.left,
      parentCls: (el.parentElement.className || '').toString().slice(0, 48),
      scroller: sc,
      docScrollTop: window.scrollY,
      hits,
      // 与底栏 / 胶囊的相交
      vsBar: inter(rect, bar ? r(bar) : null),
      vsDock: inter(rect, dock ? r(dock) : null),
    };
  });

  return {
    recordActionsCount: acts.length,
    actions: info,
    hasBar: !!bar,
    hasDock: !!dock,
    bar: r(bar),
    dock: r(dock),
    dockPos: dock ? getComputedStyle(dock).position : null,
    shellCls: shell ? shell.className : null,
    shellRows: shell ? getComputedStyle(shell).gridTemplateRows : null,
    mainCls: main ? main.className : null,
    mainOverflowY: main ? getComputedStyle(main).overflowY : null,
    doc: { scrollY: window.scrollY, sh: document.documentElement.scrollHeight,
           ih: window.innerHeight, sw: document.documentElement.scrollWidth,
           cw: document.documentElement.clientWidth },
    // 整页视图里 .record-page 的底部留白（fixed 底栏的补偿）
    recordPagePad: (() => {
      const p = document.querySelector('.record-page');
      return p ? { padBottom: getComputedStyle(p).paddingBottom, rect: r(p) } : null;
    })(),
    // 编辑视图里是否还挂着底栏 DOM
    tabBarItems: document.querySelectorAll('.glass-tab-bar__item').length,
  };
}
"""

SHEET_Z_JS = r"""
() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { x:+b.x.toFixed(1), y:+b.y.toFixed(1), w:+b.width.toFixed(1), h:+b.height.toFixed(1) }; };
  const ov = document.querySelector('.glass-sheet-overlay, .glass-modal, [role="dialog"]');
  const panel = ov ? (ov.querySelector('.glass-sheet, .glass-modal__panel') || ov) : null;
  const dock = document.querySelector('.glass-tab-bar-dock');
  const bar = document.querySelector('.glass-tab-bar');
  const z = (el) => { if (!el) return null; let p = el, out = [];
    while (p && p !== document.documentElement) { const cs = getComputedStyle(p);
      if (cs.zIndex !== 'auto' && cs.position !== 'static') out.push({ cls: (p.className||p.tagName).toString().slice(0,40), z: cs.zIndex, pos: cs.position });
      p = p.parentElement; } return out; };
  return {
    overlayZ: z(ov), dockZ: z(dock),
    overlayRect: r(ov), panelRect: r(panel), dockRect: r(dock), barRect: r(bar),
    recordActionsInSheet: ov ? ov.querySelectorAll('.record-actions').length : 0,
    // 弹层面板是否完全盖住胶囊（矩形包含）
    coversBar: (() => { const p = r(panel), b = r(bar);
      if (!p || !b) return null;
      return p.x <= b.x && p.y <= b.y && p.x + p.w >= b.x + b.w && p.y + p.h >= b.y + b.h; })(),
  };
}
"""

# 弹层（Sheet）内部是否有 .record-actions：打开「关闭场次」这类块级确认层做一次计数
SHEET_PROBE = r"""
() => {
  const sheets = [...document.querySelectorAll('.glass-sheet-overlay, .glass-modal, [role="dialog"]')];
  return {
    sheets: sheets.length,
    sheetRecordsActions: document.querySelectorAll('.glass-sheet-overlay .record-actions, .glass-modal .record-actions, [role="dialog"] .record-actions').length,
    sheetCls: sheets.map((s) => (s.className || s.tagName).toString().slice(0, 48)),
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
        page.get_by_role("button", name="记一笔").last.wait_for(timeout=25000)

        # --- 场景 A：整页编辑视图（开单一单，进入 .record-actions） ---
        page.get_by_role("button", name="记一笔").last.click()
        page.get_by_role("button", name="添加商品").first.wait_for(timeout=8000)
        page.wait_for_timeout(700)
        result["editor"] = page.evaluate(PROBE)
        shot(page, "probe-actions-editor.png")
        print("[A] 编辑器 :", json.dumps(
            {k: result["editor"][k] for k in ("recordActionsCount", "hasBar", "hasDock", "shellCls", "tabBarItems", "doc")},
            ensure_ascii=False))
        for a in result["editor"]["actions"]:
            print("    actions", a["cls"], a["position"], a["rect"], "vsDock=", a["vsDock"], "vsBar=", a["vsBar"],
                  "scroller=", a["scroller"]["cls"], "hits=", [h["inside"] for h in a["hits"]])

        # --- 场景 B：Sheet（关闭场次 / 选商品层）里是否有 .record-actions ---
        result["sheetPicker"] = page.evaluate(SHEET_PROBE)
        print("[B] 选商品层:", json.dumps(result["sheetPicker"], ensure_ascii=False))

        # 退出编辑器（整页编辑视图的返回按钮统一叫「返回」）
        if page.get_by_role("button", name="返回").count():
            page.get_by_role("button", name="返回").first.click()
        else:
            page.go_back()
        page.wait_for_timeout(800)
        if page.locator(".record-actions").count():
            page.go_back()
            page.wait_for_timeout(800)

        # --- 场景 C：进货页（.record-actions--above-dock） ---
        page.get_by_role("button", name="进货").first.click()
        page.wait_for_timeout(900)
        result["purchase"] = page.evaluate(PROBE)
        shot(page, "probe-actions-purchase.png")
        print("[C] 进货页 :", json.dumps(
            {k: result["purchase"][k] for k in ("recordActionsCount", "hasBar", "hasDock", "shellRows")},
            ensure_ascii=False))
        for a in result["purchase"]["actions"]:
            print("    actions", a["cls"], a["position"], a["rect"], "vsDock=", a["vsDock"], "vsBar=", a["vsBar"],
                  "scroller=", a["scroller"]["cls"])

        # 进货页滚到底再看一次（sticky 的行为与滚动位置有关）
        page.evaluate("""() => { const m = document.querySelector('.app-main');
            m.scrollTop = m.scrollHeight; }""")
        page.wait_for_timeout(400)
        result["purchaseBottom"] = page.evaluate(PROBE)
        shot(page, "probe-actions-purchase-bottom.png")
        for a in result["purchaseBottom"]["actions"]:
            print("    [底] actions", a["position"], a["rect"], "vsDock=", a["vsDock"])

        # --- 场景 D：真正的弹层（进货页「今天录入」Sheet）与底栏的层级关系 ---
        # 目的：确认弹层内没有 .record-actions，且弹层遮罩/面板的 z-index 高于底栏
        # （高 = 弹层完全盖住底栏，不存在「底栏浮在弹层上」）。
        page.get_by_role("button", name="记账").first.click()
        page.wait_for_timeout(400)
        page.get_by_role("button", name="进货").first.click()
        page.wait_for_timeout(700)
        item = page.locator(".app-main .glass-list__item").first
        if item.count():
            item.click()
            page.wait_for_timeout(800)
            result["sheet"] = page.evaluate(SHEET_Z_JS)
            print("[D] 进货「今天录入」弹层:", json.dumps(result["sheet"], ensure_ascii=False))
            shot(page, "probe-actions-sheet.png")
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)

        browser.close()

    path = os.path.join(os.path.dirname(__file__), "result-actions.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"\n结果 -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())