"""底栏「安全带」改造实测（2026-11-12）。

目的：证明浮动底栏改成 .app-shell 网格第 4 行之后，
**7 个页面 × 5 个滚动位置**，底栏胶囊与可见内容元素的相交面积恒为 0。

用法（先 pnpm dev）：
    python scripts/dock-belt-20261112/measure.py --phase=after
    python scripts/dock-belt-20261112/measure.py --phase=before   # 需要先 git stash

两个 phase 各写一份 JSON，方便对比胶囊 rect / 计算样式。

口径说明（很重要）：
1. 「相交面积」只算**可见**部分 —— 元素 rect 先与滚动容器的 padding box
   （= 用户真正看得见的那块）求交，再与胶囊 rect 求交。超出滚动容器下沿的
   部分浏览器根本不绘制，所以不该记成「被遮挡」。
2. 另外做一次命中测试（elementFromPoint 网格采样）：胶囊上任意一点的最上层
   元素必须落在 .glass-tab-bar 里，否则说明真有东西画在胶囊上面。
   这一条不受 rect 口径影响，是「肉眼是否被盖」的硬证据。
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import Page, sync_playwright

BASE = os.environ.get("AUDIT_BASE", "http://127.0.0.1:5173/")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "docs", "screenshots", "dock-belt")
RESULT = os.path.join(os.path.dirname(__file__))

RATIOS = [0, 0.25, 0.5, 0.75, 1.0]

# 在页面里跑的测量函数（字符串形式，Playwright 只接受一个表达式）
MEASURE_JS = r"""
(ratio) => {
  const out = {};
  const bar = document.querySelector('.glass-tab-bar');
  const dock = document.querySelector('.glass-tab-bar-dock');
  const shell = document.querySelector('.app-shell');
  const main = document.querySelector('.app-main');

  // 滚动容器：库存页是 .stock-page__scroll，其余是 .app-main
  const candidates = [main, document.querySelector('.stock-page__scroll')];
  let scroller = null;
  for (const c of candidates) {
    if (!c) continue;
    if (c.scrollHeight - c.clientHeight > 4) { scroller = c; break; }
    if (!scroller) scroller = c;
  }
  if (scroller) {
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.round(max * ratio);
  }

  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
             top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };

  out.ratio = ratio;
  out.hasBar = !!bar;
  out.bar = rect(bar);
  out.dock = rect(dock);
  out.shell = rect(shell);
  out.shellRows = shell ? getComputedStyle(shell).gridTemplateRows : null;
  out.scroller = scroller ? {
    cls: scroller.className.split(' ')[0],
    rect: rect(scroller),
    scrollTop: scroller.scrollTop,
    max: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
  } : null;
  out.doc = {
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
  };

  const dockRect = rect(document.querySelector('.checkout-dock'));
  out.checkoutDock = dockRect;

  if (!bar || !scroller) { out.count = 0; out.area = 0; out.maxArea = 0; out.samples = []; out.hitBad = []; return out; }

  const c = bar.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  // 可见区 = 滚动容器的 padding box（overflow 裁剪就在这一层）
  const vis = { top: s.top, bottom: s.bottom, left: s.left, right: s.right };

  let count = 0, area = 0, maxArea = 0, worst = null;
  const samples = [];
  for (const el of scroller.querySelectorAll('*')) {
    // 浮层（弹层 / toast / 浮条本身）不算「内容」：它们本来就是浮在内容上的
    if (el.closest('.glass-sheet-overlay, .glass-modal, .toast, .glass-toast, .glass-tab-bar-dock')) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const top = Math.max(r.top, vis.top);
    const bottom = Math.min(r.bottom, vis.bottom);
    if (bottom - top <= 0) continue;
    const iw = Math.min(c.right, r.right) - Math.max(c.left, r.left);
    const ih = Math.min(c.bottom, bottom) - Math.max(c.top, top);
    if (iw <= 0 || ih <= 0) continue;
    const a = iw * ih;
    count += 1; area += a;
    if (a > maxArea) {
      maxArea = a;
      worst = { cls: (el.className || el.tagName).toString().slice(0, 60), w: +iw.toFixed(1), h: +ih.toFixed(1), a: +a.toFixed(1) };
    }
    if (samples.length < 5) samples.push({ cls: (el.className || el.tagName).toString().slice(0, 40), a: +a.toFixed(1) });
  }
  out.count = count;
  out.area = +area.toFixed(1);
  out.maxArea = +maxArea.toFixed(1);
  out.worst = worst;
  out.samples = samples;

  // 命中测试：胶囊区域内的点，最上层元素必须属于胶囊
  const hitBad = [];
  const cols = 7, rows = 3;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = c.left + (c.width * (i + 0.5)) / cols;
      const y = c.top + (c.height * (j + 0.5)) / rows;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !hit.closest('.glass-tab-bar')) {
        hitBad.push({ x: Math.round(x), y: Math.round(y), hit: hit ? (hit.className || hit.tagName).toString().slice(0, 50) : null });
      }
    }
  }
  out.hitBad = hitBad;

  // 最后一行可达性：滚动容器最后一个流内子元素（跳过 fixed / sticky 浮条）
  const flow = [...scroller.children].filter((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return r.height > 0 && cs.position !== 'fixed' && cs.position !== 'sticky';
  });
  const last = flow[flow.length - 1];
  // 只算「看得见」的底边：超出滚动容器的部分本来就被裁掉了
  const clipBottom = (v) => +Math.min(v, s.bottom).toFixed(1);
  out.lastBlock = last ? { cls: (last.className || last.tagName).toString().slice(0, 40), bottom: clipBottom(last.getBoundingClientRect().bottom) } : null;
  // 记账页：最后一单在 .page-stack 里、浮条之前
  const stack = scroller.querySelector(':scope > .page-stack');
  if (stack) {
    const kids = [...stack.children].filter((el) => {
      const cs = getComputedStyle(el);
      return el.getBoundingClientRect().height > 0 && cs.position !== 'fixed';
    });
    const target = kids.filter((el) => !el.classList.contains('checkout-dock')).pop();
    if (target) out.lastBlock = { cls: ('page-stack>' + (target.className || target.tagName)).toString().slice(0, 48), bottom: clipBottom(target.getBoundingClientRect().bottom) };
    if (out.checkoutDock && target) out.lastBlock.dockGap = +(out.checkoutDock.y - clipBottom(target.getBoundingClientRect().bottom)).toFixed(1);
  }
  out.barGap = out.lastBlock && out.bar ? +(out.bar.top - out.lastBlock.bottom).toFixed(1) : null;
  // 浮条与底栏是否相交
  if (out.checkoutDock) {
    const d = out.checkoutDock;
    const iw = Math.min(c.right, d.x + d.w) - Math.max(c.left, d.x);
    const ih = Math.min(c.bottom, d.y + d.h) - Math.max(c.top, d.y);
    out.dockVsBar = iw > 0 && ih > 0 ? +(iw * ih).toFixed(1) : 0;
  } else {
    out.dockVsBar = null;
  }

  // 浮条盖住多少可见内容。它本来就是「常驻动作条」，滚动中会压在内容上
  // （改前 fixed 也一样），这里只如实记账，不属于「底栏遮挡」那个口径。
  if (out.checkoutDock) {
    const dr = document.querySelector('.checkout-dock').getBoundingClientRect();
    let n = 0, sum = 0, worst = null;
    for (const el of scroller.querySelectorAll('*')) {
      if (el.closest('.checkout-dock, .glass-sheet-overlay, .toast, .glass-toast')) continue;
      if (getComputedStyle(el).position === 'fixed') continue;
      // 只数叶子元素：父子同时算会把同一块面积重复累加，总数超过浮条自身面积
      if (el.children.length) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const top = Math.max(r.top, vis.top), bottom = Math.min(r.bottom, vis.bottom);
      if (bottom - top <= 0) continue;
      const iw = Math.min(dr.right, r.right) - Math.max(dr.left, r.left);
      const ih = Math.min(dr.bottom, bottom) - Math.max(dr.top, top);
      if (iw <= 0 || ih <= 0) continue;
      n += 1; sum += iw * ih;
      if (!worst || iw * ih > worst.a) worst = { cls: (el.className || el.tagName).toString().slice(0, 40), a: +((iw * ih).toFixed(1)) };
    }
    out.dockCover = { count: n, area: +sum.toFixed(1), worst };
  } else {
    out.dockCover = null;
  }

  /*
   * `.record-actions`（开单/进货的底部动作栏）。它历史上是 fixed，
   * 本轮要证明两点：
   *   1) 它只在「整页编辑视图」和「进货页」出现，而整页编辑视图不渲染底栏；
   *   2) 在会渲染底栏的页面里它是 sticky 且与胶囊相交 0 平方像素。
   * 所以每个滚动位置都记一次 rect / position / 与胶囊的相交面积。
   */
  /*
   * 「最后一行」的真实位置：滚动容器里**可见叶子元素**的底边最大值。
   * 用叶子而不是流内直接子元素，是因为卡片内部还有一层 padding / 说明文字，
   * 直接子元素量到的是卡片盒子的底边（含 16px 内边距），会把间距算大 5~20px。
   * 排除项：
   *   - 底栏带本身（.glass-tab-bar-dock）：它是「底栏顶边」的参照物；
   *   - 结算浮条 / 进货保存栏：它们本来就是常驻动作条，不算「最后一行」。
   */
  const skipSel = '.glass-tab-bar-dock, .checkout-dock, .record-actions';
  let lastLeafBottom = null;
  let lastLeaf = null;
  for (const el of scroller.querySelectorAll('*')) {
    if (el.closest(skipSel)) continue;
    if (el.children.length) continue;            // 只取叶子
    const cs2 = getComputedStyle(el);
    if (cs2.position === 'fixed') continue;
    const rr = el.getBoundingClientRect();
    if (rr.width < 2 || rr.height < 2) continue;
    const b = Math.min(rr.bottom, s.bottom);
    if (b <= s.top + 1) continue;                // 完全在视口上方
    if (lastLeafBottom === null || b > lastLeafBottom) {
      lastLeafBottom = +b.toFixed(1);
      lastLeaf = { cls: (el.className || el.tagName).toString().slice(0, 40), bottom: lastLeafBottom };
    }
  }
  out.lastLeaf = lastLeaf;
  // 底栏带的顶边（= 内容区滚动视口的底边），不是胶囊顶边（那还差 8px 内边距）
  out.dockTop = dock ? +dock.getBoundingClientRect().top.toFixed(1) : null;
  out.lastLeafGap = (lastLeafBottom !== null && dock)
    ? +(dock.getBoundingClientRect().top - lastLeafBottom).toFixed(1) : null;

  /* 进货页：保存栏本身就是「最后一行」的参照（它是 sticky BFC 的最后一个可见块）。 */
  const pa = document.querySelector('.record-actions--above-dock');
  if (pa && dock) {
    const pRect = pa.getBoundingClientRect();
    out.purchaseBar = { rect: rect(pa), position: getComputedStyle(pa).position };
    out.purchaseBarGap = +(dock.getBoundingClientRect().top - pRect.bottom).toFixed(1);
    out.lastLeafGap = out.purchaseBarGap;       // 这一页用保存栏底边代替叶子底边
  }

  const acts = [...document.querySelectorAll('.record-actions')];
  out.recordActions = acts.map((el) => {
    const cs = getComputedStyle(el);
    const ar = el.getBoundingClientRect();
    const iw = Math.min(c.right, ar.right) - Math.max(c.left, ar.left);
    const ih = Math.min(c.bottom, ar.bottom) - Math.max(c.top, ar.top);
    return {
      cls: el.className,
      position: cs.position,
      rect: rect(el),
      vsBar: iw > 0 && ih > 0 ? +(iw * ih).toFixed(1) : 0,
    };
  });
  return out;
}
"""

STYLE_JS = r"""
() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      rect: (() => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; })(),
      position: cs.position,
      borderRadius: cs.borderRadius,
      backgroundImage: cs.backgroundImage.slice(0, 90),
      backgroundColor: cs.backgroundColor,
      backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
      boxShadow: cs.boxShadow.slice(0, 120),
      padding: cs.padding,
      transform: cs.transform,
      zIndex: cs.zIndex,
    };
  };
  return {
    dock: pick('.glass-tab-bar-dock'),
    capsule: pick('.glass-tab-bar'),
    appMain: (() => { const cs = getComputedStyle(document.querySelector('.app-main')); return { paddingBottom: cs.paddingBottom, paddingTop: cs.paddingTop }; })(),
    shell: (() => { const cs = getComputedStyle(document.querySelector('.app-shell')); return { gridTemplateRows: cs.gridTemplateRows, height: cs.height }; })(),
    rowHeights: (() => {
      const shell = document.querySelector('.app-shell');
      const cs = getComputedStyle(shell);
      return cs.gridTemplateRows;
    })(),
    // 第 4 行（底栏带）实际高度 = dock 高度
    dockH: document.querySelector('.glass-tab-bar-dock') ? +document.querySelector('.glass-tab-bar-dock').getBoundingClientRect().height.toFixed(1) : null,
  };
}
"""


def shot(page: Page, name: str) -> None:
    page.screenshot(path=os.path.join(OUT, name))
    print(f"    screenshot -> docs/screenshots/dock-belt/{name}")


def seed(page: Page) -> None:
    """造一点数据，让 7 个页面都长到能滚（6 单 + 2 条进货）。"""
    page.goto(BASE, wait_until="networkidle")
    page.get_by_role("button", name="记一笔").last.wait_for(timeout=25000)
    page.get_by_role("button", name="记一笔").last.click()
    page.get_by_role("button", name="添加商品").first.wait_for(timeout=8000)
    for i in range(6):
        # 第一次要自己点「添加商品」；保存并记下一单之后，选商品层会自动重开
        if page.locator(".picker .prod-btn").count() == 0:
            page.get_by_role("button", name="添加商品").first.click()
        page.wait_for_selector(".picker .prod-btn", timeout=8000)
        page.wait_for_timeout(700)  # arming：弹层刚开时 pointer-events:none
        btns = page.locator(".picker .prod-btn")
        btns.nth(0).click()
        page.wait_for_timeout(150)
        if btns.count() > 1:
            btns.nth(1).click()
            page.wait_for_timeout(150)
        page.get_by_role("button", name="完成（回单据）").click()
        page.get_by_role("button", name="保存并记下一单").click()
        page.wait_for_timeout(1400)
        page.mouse.move(4, 4)
        print(f"    已记 {i + 1} 单")
    # 最后一次保存后自动重开的选商品层：关掉它再返回
    if page.locator(".picker .prod-btn").count():
        page.get_by_role("button", name="完成（回单据）").click()
        page.wait_for_timeout(300)
    page.get_by_role("button", name="返回").click()
    page.wait_for_timeout(600)
    page.wait_for_selector(".toast", state="detached", timeout=12000)

    # 进货 12 条：进货页只有「录入 + 最近进货」两张卡，条数太少会不足一屏、量不出滚动
    for _ in range(12):
        page.get_by_role("button", name="进货").click()
        page.locator(".picker-trigger").first.click()
        page.wait_for_selector(".picker .prod-btn", timeout=5000)
        page.locator(".picker .prod-btn").first.click()
        page.wait_for_selector(".picker", state="detached", timeout=5000)
        page.get_by_label("数量", exact=False).fill("3")
        page.get_by_label("进价", exact=False).fill("12")
        page.get_by_role("button", name="保存这一条").click()
        page.wait_for_timeout(900)
        page.mouse.move(4, 4)
        page.wait_for_timeout(200)
    page.get_by_role("button", name="记账").click()
    page.wait_for_timeout(500)


PAGES = [
    ("记账", "tab"),
    ("进货", "tab"),
    ("库存", "tab"),
    ("报表", "tab"),
    ("更多", "tab"),
    ("商品管理", "sub"),
    ("设置", "sub"),
]


def goto_page(page: Page, name: str, kind: str) -> None:
    if kind == "tab":
        page.get_by_role("button", name=name, exact=True).first.click()
    else:
        page.get_by_role("button", name="更多", exact=True).first.click()
        page.wait_for_timeout(250)
        label = "商品管理" if name == "商品管理" else "设置与同步"
        page.locator(".list-item", has_text=label).first.click()
    page.wait_for_timeout(650)


def back(page: Page) -> None:
    b = page.locator(".back-btn")
    if b.count():
        b.first.click()
        page.wait_for_timeout(400)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", default="after", choices=["before", "after"])
    ap.add_argument(
        "--h",
        type=int,
        default=844,
        help="视口高度；844 是验收口径，620 是补充压力位（内容更容易超一屏）",
    )
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)

    result: dict = {"phase": args.phase, "h": args.h, "pages": {}, "styles": {}, "toast": {}}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": 390, "height": args.h},
            device_scale_factor=2,
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
        )
        page = ctx.new_page()
        ctx.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
        page.goto(BASE, wait_until="networkidle")
        seed(page)

        for name, kind in PAGES:
            goto_page(page, name, kind)
            rows = []
            for r in RATIOS:
                m = page.evaluate(MEASURE_JS, r)
                page.wait_for_timeout(180)
                m = page.evaluate(MEASURE_JS, r)  # 等滚动停稳再量一次
                rows.append(m)
                last = m.get("lastBlock")
                print(
                    f"  {name:>6} @{int(r*100):>3}%  bar={'有' if m['hasBar'] else '无'} "
                    f"相交={m['count']} 处 / {m['area']}px²  命中异常={len(m['hitBad'])}  "
                    f"最后一块底={last['bottom'] if last else '-'} 间距={m.get('barGap')} "
                    f"浮条×底栏={m.get('dockVsBar')} 浮条盖内容={(m.get('dockCover') or {}).get('count')}处/{(m.get('dockCover') or {}).get('area')}px² "
                    f"动作栏={[(a['position'], a['vsBar']) for a in m.get('recordActions') or []]} "
                    f"末叶子={m.get('lastLeaf')} 底栏带顶={m.get('dockTop')} 末行间距={m.get('lastLeafGap')} 行={m.get('shellRows')}"
                )
                if r in (0.0, 1.0):
                    shot(page, f"{args.phase}-{name}-{int(r*100)}.png")
            result["pages"][name] = rows
            if kind == "sub":
                back(page)
            result["styles"][name] = page.evaluate(STYLE_JS) if name == "记账" else result["styles"].get(name)

        # 记账页：胶囊特写 + 浮条与底栏
        goto_page(page, "记账", "tab")
        page.evaluate(MEASURE_JS, 0)
        page.wait_for_timeout(200)
        result["styles"]["record-top"] = page.evaluate(STYLE_JS)
        shot(page, f"{args.phase}-记账-胶囊特写.png")
        el = page.locator(".glass-tab-bar")
        box = el.bounding_box()
        if box:
            page.screenshot(path=os.path.join(OUT, f"{args.phase}-胶囊-裁剪.png"), clip={
                "x": max(0, box["x"] - 20), "y": max(0, box["y"] - 20),
                "width": min(390, box["width"] + 40), "height": box["height"] + 40,
            })

        # Toast：切到报表触发一次「复制」类提示，或直接调 showToast 不方便，
        # 改用「更多 → 商品管理」里必现的提示不稳定；这里用同步角标点击（离线会提示）
        page.get_by_role("button", name="更多", exact=True).first.click()
        page.wait_for_timeout(400)
        page.locator(".sync-dot, .app-nav .glass-pill").first.click()
        page.wait_for_timeout(600)
        for t in page.locator(".toast").all():
            if t.is_visible():
                tb = page.evaluate(
                    """() => { const t = document.querySelector('.toast') || document.querySelector('.glass-toast');
                        const b = document.querySelector('.glass-tab-bar');
                        if (!t) return null;
                        const tr = t.getBoundingClientRect();
                        const br = b ? b.getBoundingClientRect() : null;
                        return { rect: {x:+tr.x.toFixed(1), y:+tr.y.toFixed(1), w:+tr.width.toFixed(1), h:+tr.height.toFixed(1)},
                                 barTop: br ? +br.top.toFixed(1) : null,
                                 coversBar: br ? (tr.bottom > br.top && tr.right > br.left && tr.left < br.right) : null }; }"""
                )
                result["toast"] = tb
                shot(page, f"{args.phase}-toast.png")
                break

        browser.close()

    suffix = "" if args.h == 844 else f"-{args.h}"
    path = os.path.join(RESULT, f"result-{args.phase}{suffix}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"\n结果 -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

