"""干净的界面截图：逐个页面截图，等 toast 消失，并打印关键计算样式。
用法（先 pnpm dev）：python scripts/capture.py [base_url]
"""

import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173/"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "docs", "screenshots", "ui")
os.makedirs(OUT, exist_ok=True)


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=2,
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
        )
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        for i in range(40):
            try:
                page.goto(BASE, wait_until="networkidle", timeout=8000)
                break
            except Exception:
                if i == 39:
                    raise
                time.sleep(0.5)

        page.wait_for_selector("text=大地红 1000 响", timeout=20000)
        page.wait_for_timeout(600)

        def shot(name):
            page.wait_for_timeout(350)
            page.screenshot(path=os.path.join(OUT, name))
            print("  ->", name)

        print("[ui] 开单")
        shot("01-开单.png")

        print("[ui] 购物车")
        page.locator(".prod-btn").first.click()
        page.wait_for_selector(".checkout-bar")
        page.locator(".checkout-dock__count").click()
        page.wait_for_timeout(500)
        shot("02-购物车.png")
        page.locator(".glass-sheet__close").click()
        page.wait_for_timeout(400)

        print("[ui] 结算")
        page.get_by_role("button", name="结算").click()
        page.wait_for_timeout(500)
        shot("03-结算.png")
        page.get_by_role("button", name="现金").click()
        page.wait_for_selector(".toast")
        page.wait_for_selector(".toast", state="detached", timeout=8000)

        print("[ui] 进货")
        page.get_by_role("button", name="进货").click()
        page.wait_for_timeout(500)
        shot("04-进货.png")

        print("[ui] 库存")
        page.get_by_role("button", name="库存").click()
        page.wait_for_timeout(500)
        shot("05-库存.png")

        print("[ui] 报表")
        page.get_by_role("button", name="报表").click()
        page.wait_for_timeout(500)
        shot("06-报表.png")

        print("[ui] 更多")
        page.get_by_role("button", name="更多").click()
        page.wait_for_timeout(500)
        shot("07-更多.png")

        print("[ui] 商品管理")
        page.locator(".list-item", has_text="商品管理").click()
        page.wait_for_timeout(600)
        shot("08-商品管理.png")

        print("[ui] 商品编辑")
        page.locator(".list-item").first.click()
        page.wait_for_timeout(600)
        shot("09-商品编辑.png")
        page.locator(".glass-sheet__close").click()
        page.wait_for_timeout(400)

        print("[ui] 设置")
        page.locator(".back-btn").click()
        page.wait_for_timeout(400)
        page.locator(".list-item", has_text="设置与同步").click()
        page.wait_for_timeout(600)
        shot("10-设置.png")

        print("[ui] 浅色模式")
        page.locator(".back-btn").click()
        page.wait_for_timeout(400)
        page.get_by_role("button", name="开单").click()
        page.wait_for_timeout(400)
        page.get_by_role("button", name="切到浅色").click()
        page.wait_for_timeout(700)
        shot("11-浅色-开单.png")
        page.get_by_role("button", name="报表").click()
        page.wait_for_timeout(500)
        shot("12-浅色-报表.png")
        page.get_by_role("button", name="切到深色").click()

        # 关键字号检查
        sizes = page.evaluate(
            """() => {
                const out = {};
                const t = document.querySelector('.section-title');
                if (t) out.sectionTitle = getComputedStyle(t).fontSize;
                const b = document.querySelector('.glass-btn');
                if (b) out.btnHeight = getComputedStyle(b).height;
                const nav = document.querySelector('.app-nav');
                if (nav) out.navH = Math.round(nav.getBoundingClientRect().height);
                const dock = document.querySelector('.glass-tab-bar-dock');
                if (dock) out.dockH = Math.round(dock.getBoundingClientRect().height);
                const main = document.querySelector('.app-main');
                if (main) out.mainPadBottom = getComputedStyle(main).paddingBottom;
                return out;
            }"""
        )
        print("computed:", sizes)

        browser.close()

    if errors:
        print("!! errors:")
        for e in errors:
            print("  ", e[:300])
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())