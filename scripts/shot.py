"""给指定 URL 截图（手机视口），用于评估设计参考。
用法：python scripts/shot.py <url> <out.png> [width] [height]
"""

import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

from playwright.sync_api import sync_playwright


def main() -> int:
    url = sys.argv[1]
    out = sys.argv[2]
    w = int(sys.argv[3]) if len(sys.argv) > 3 else 390
    h = int(sys.argv[4]) if len(sys.argv) > 4 else 844

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": w, "height": h},
            device_scale_factor=2,
            locale="zh-CN",
        )
        page = ctx.new_page()
        for attempt in range(3):
            try:
                page.goto(url, wait_until="networkidle", timeout=30000)
                break
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(1)
        page.wait_for_timeout(1500)
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        page.screenshot(path=out, full_page=False)
        print(f"saved {out} ({os.path.getsize(out)} bytes)")
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())