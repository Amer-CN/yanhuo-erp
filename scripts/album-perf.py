"""卡册网格滚动性能探针（仅本机预览，不碰真实账本）。

用法：先 `pnpm build && pnpm preview --port 4174`，再
    python scripts/album-perf.py --url http://127.0.0.1:4174/ --count 90

会在独立浏览器上下文里注入示例商品、打开卡册、滚动网格，采集 rAF 帧间隔。
"""

import argparse
import json
import statistics
from pathlib import Path

from playwright.sync_api import sync_playwright

FAMILIES = [
    "加特林",
    "水母",
    "风车",
    "蜻蜓",
    "孔雀开屏",
    "银色喷泉",
    "仙女棒",
    "二踢脚",
    "大地红",
    "向日葵",
    "蝴蝶",
    "小蜜蜂",
    "七彩莲花",
    "窜天猴",
    "金玉满堂",
    "彩菊",
]

INJECT = """
async ({ names, count }) => {
  const iso = new Date().toISOString();
  const list = Array.from({ length: count }, (_, i) => ({
    id: 'perf-' + i,
    name: names[i % names.length] + ' ' + (i + 1),
    category: '烟花',
    unitBase: '个',
    boxQty: 0,
    priceList: 1000,
    negotiable: true,
    archived: false,
    sortOrder: i,
    createdAt: iso,
    updatedAt: iso
  }));
  return await new Promise((resolve, reject) => {
    const req = indexedDB.open('yanhuo-erp');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('products', 'readwrite');
      const store = tx.objectStore('products');
      list.forEach((p) => store.put(p));
      tx.oncomplete = () => { db.close(); resolve(list.length); };
      tx.onerror = () => reject(tx.error);
    };
  });
}
"""

START_SAMPLER = """
() => {
  window.__perf = { frames: [], run: true };
  let last = performance.now();
  const tick = (t) => {
    if (!window.__perf.run) return;
    window.__perf.frames.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
"""

STOP_SAMPLER = """
() => {
  window.__perf.run = false;
  return window.__perf.frames.slice(2);
}
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:4174/")
    parser.add_argument("--count", type=int, default=90)
    parser.add_argument("--out", default="")
    parser.add_argument(
        "--no-defer",
        action="store_true",
        help="禁用离屏延迟渲染，用来对照离屏渲染的贡献",
    )
    args = parser.parse_args()

    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=2,
            is_mobile=True,
            has_touch=True,
        )
        page = context.new_page()
        page.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
        page.goto(args.url, wait_until="networkidle")
        page.wait_for_timeout(1200)
        page.evaluate(INJECT, {"names": FAMILIES, "count": args.count})
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(1200)

        page.get_by_role("button", name="更多", exact=True).click()
        page.wait_for_timeout(300)
        page.get_by_text("我们的卡册", exact=True).click()
        page.wait_for_timeout(1000)

        if args.no_defer:
            page.add_style_tag(
                content=".album-card { content-visibility: visible !important; contain-intrinsic-size: none !important; }"
            )

        page.evaluate(
            "() => { const m = document.querySelector('.app-main'); if (m) m.scrollTop = 0; }"
        )
        page.evaluate(START_SAMPLER)

        for _ in range(45):
            page.evaluate(
                "() => { const m = document.querySelector('.app-main'); if (m) m.scrollBy(0, 320); }"
            )
            page.wait_for_timeout(70)

        frames = page.evaluate(STOP_SAMPLER)
        browser.close()

    if not frames:
        print(json.dumps({"error": "no frames captured"}, ensure_ascii=False))
        return 1

    avg = statistics.mean(frames)
    p95 = sorted(frames)[int(len(frames) * 0.95) - 1]
    over34 = sum(1 for f in frames if f > 34)
    over50 = sum(1 for f in frames if f > 50)
    report = {
        "cards": args.count,
        "frames": len(frames),
        "avg_ms": round(avg, 2),
        "p95_ms": round(p95, 2),
        "max_ms": round(max(frames), 2),
        "over_34ms": over34,
        "over_50ms": over50,
        "fps_avg": round(1000 / avg, 1) if avg else None,
    }
    print(json.dumps(report, ensure_ascii=False))
    if args.out:
        Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
