"""前端性能基线 / 回归测量（Playwright + Chromium，移动端模拟）。

用法:
    pnpm build
    pnpm preview --port 4173
    python scripts/perf-cwv.py --runs 5 --out .perf/baseline.json

测量口径固定为：412x915 移动视口、4x CPU 降速、Slow 4G（150ms RTT / 1.6Mbps），
禁用云同步（localStorage['yh-sync-disabled']=1）避免测试数据写真实账本。
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

INIT = """
(() => {
  try { localStorage.setItem('yh-sync-disabled', '1'); } catch (e) {}
  const p = window.__perf = {
    lcp: 0, lcpEl: '', cls: 0, fcp: 0, longTasks: [], tbt: 0
  };
  const safe = (fn) => { try { fn(); } catch (e) {} };
  safe(() => new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      p.lcp = e.startTime;
      const el = e.element;
      p.lcpEl = el ? el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : '') : '';
    }
  }).observe({ type: 'largest-contentful-paint', buffered: true }));
  safe(() => new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (!e.hadRecentInput) p.cls += e.value;
  }).observe({ type: 'layout-shift', buffered: true }));
  safe(() => new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') p.fcp = e.startTime;
  }).observe({ type: 'paint', buffered: true }));
  safe(() => new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      p.longTasks.push(+e.duration.toFixed(1));
      if (e.duration > 50) p.tbt += e.duration - 50;
    }
  }).observe({ type: 'longtask', buffered: true }));
})();
"""

MEASURE_CLICK = """
(kind) => new Promise((resolve) => {
  let target = null;
  if (kind === 'editor') target = [...document.querySelectorAll('button')].find(b => /记一笔/.test(b.textContent || ''));
  else target = [...document.querySelectorAll('.glass-tab-bar__item')].find(b => (b.textContent || '').includes(kind));
  if (!target) return resolve(-1);
  const t0 = performance.now();
  target.click();
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)));
})
"""


def median(values):
    values = [v for v in values if isinstance(v, (int, float)) and v >= 0]
    return round(statistics.median(values), 1) if values else None


def run_once(browser, url):
    context = browser.new_context(
        viewport={"width": 412, "height": 915},
        device_scale_factor=2,
        is_mobile=True,
        has_touch=True,
        service_workers="block",
    )
    page = context.new_page()
    page.add_init_script(INIT)
    cdp = context.new_cdp_session(page)
    cdp.send("Network.enable")
    cdp.send(
        "Network.emulateNetworkConditions",
        {
            "offline": False,
            "latency": 150,
            "downloadThroughput": int(1.6 * 1024 * 1024 / 8),
            "uploadThroughput": int(750 * 1024 / 8),
        },
    )
    cdp.send("Emulation.setCPUThrottlingRate", {"rate": 4})

    page.goto(url, wait_until="load", timeout=120000)
    # 首屏壳体（底部 tab bar）出现的时间，代表页面真正可用
    page.wait_for_function("() => !!document.querySelector('.glass-tab-bar')", timeout=60000)
    shell_ms = page.evaluate("performance.now()")
    page.wait_for_timeout(2500)  # 让 LCP / CLS 稳定

    metrics = page.evaluate(
        """() => {
          const nav = performance.getEntriesByType('navigation')[0];
          const res = performance.getEntriesByType('resource');
          let js = 0, css = 0, other = 0, count = 0;
          for (const r of res) {
            const size = r.transferSize || r.encodedBodySize || 0;
            count += 1;
            if (/\\.js(\\?|$)/.test(r.name)) js += size;
            else if (/\\.css(\\?|$)/.test(r.name)) css += size;
            else other += size;
          }
          return {
            ttfb: nav ? nav.responseStart - nav.startTime : 0,
            dcl: nav ? nav.domContentLoadedEventEnd : 0,
            load: nav ? nav.loadEventEnd : 0,
            fcp: __perf.fcp, lcp: __perf.lcp, lcpEl: __perf.lcpEl, cls: __perf.cls,
            tbt: __perf.tbt, longTasks: __perf.longTasks,
            requests: count, jsBytes: js, cssBytes: css, otherBytes: other
          };
        }"""
    )
    metrics["shellMs"] = round(shell_ms, 1)

    # 交互响应（点击后下一次绘制）
    metrics["clickPurchase"] = page.evaluate(MEASURE_CLICK, "进货")
    page.wait_for_timeout(300)
    metrics["clickReport"] = page.evaluate(MEASURE_CLICK, "报表")
    page.wait_for_timeout(300)
    metrics["clickRecord"] = page.evaluate(MEASURE_CLICK, "记账")
    page.wait_for_timeout(300)
    metrics["openEditor"] = page.evaluate(MEASURE_CLICK, "editor")

    page.wait_for_timeout(500)
    metrics["longTasksAll"] = page.evaluate("__perf.longTasks")
    context.close()
    return metrics


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:4173/")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--out", default="")
    ap.add_argument("--budget", action="store_true", help="超出性能预算时以非零码退出")
    args = ap.parse_args()

    runs = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--disable-dev-shm-usage"])
        for i in range(args.runs):
            r = run_once(browser, args.url)
            runs.append(r)
            print(
                f"run {i + 1}: FCP={r['fcp']:.0f}ms LCP={r['lcp']:.0f}ms CLS={r['cls']:.3f} "
                f"TBT={r['tbt']:.0f}ms shell={r['shellMs']:.0f}ms js={r['jsBytes'] / 1024:.0f}KB"
            )
        browser.close()

    keys = [
        "ttfb", "fcp", "lcp", "cls", "tbt", "shellMs", "dcl", "load",
        "requests", "jsBytes", "cssBytes", "otherBytes",
        "clickPurchase", "clickReport", "clickRecord", "openEditor",
    ]
    summary = {k: median([r.get(k) for r in runs]) for k in keys}
    summary["maxLongTask"] = median([max(r["longTasksAll"] or [0]) for r in runs])
    summary["longTaskCount"] = median([len(r["longTasksAll"]) for r in runs])
    summary["lcpEl"] = statistics.mode([r["lcpEl"] for r in runs]) if runs else ""
    summary["runs"] = runs

    print("\n== median ==")
    for k in keys:
        print(f"{k}: {summary[k]}")
    print(f"maxLongTask: {summary['maxLongTask']} ms, longTaskCount: {summary['longTaskCount']}")
    print(f"lcpEl: {summary['lcpEl']}")

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"\nwritten to {out}")

    if args.budget:
        # 4x CPU + Slow 4G 下的回归预算，留出约 50% 抖动余量
        budget = {
            "lcp": 2000, "cls": 0.1, "tbt": 200, "shellMs": 2000,
            "clickPurchase": 200, "clickReport": 200, "openEditor": 200,
        }
        bad = []
        for key, limit in budget.items():
            value = summary.get(key)
            if value is None or value > limit:
                bad.append(f"{key}={value} > {limit}")
        if bad:
            print("\nBUDGET FAIL:")
            for b in bad:
                print("  -", b)
            return 1
        print("\nBUDGET PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())