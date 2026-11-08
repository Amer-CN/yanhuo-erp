"""端到端冒烟测试：用真实 Chromium 跑一遍「开单 → 进货 → 报表 → 库存」。
用法（先 pnpm dev）：
    python scripts/e2e-smoke.py
"""

import os
import re
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5173/"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "docs", "screenshots", "e2e")
os.makedirs(OUT, exist_ok=True)

errors: list[str] = []


def shot(page, name: str) -> None:
    page.screenshot(path=os.path.join(OUT, name))
    print(f"  screenshot -> docs/screenshots/{name}")


def field_input(page, label: str):
    return page.locator(".glass-input-group").filter(has_text=label).locator("input, select").first


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
        page.on(
            "console",
            lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None,
        )
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        # 等 dev server 起来
        for i in range(60):
            try:
                page.goto(BASE, wait_until="networkidle", timeout=8000)
                break
            except Exception:
                if i == 59:
                    raise
                time.sleep(0.5)

        print("[1] 首屏")
        page.wait_for_selector("text=大地红 1000 响", timeout=20000)
        shot(page, "01-开单.png")

        print("[2] 加购 + 结算现金")
        page.locator(".prod-btn").first.click()
        page.wait_for_selector(".checkout-bar", timeout=5000)
        shot(page, "02-购物车.png")
        page.get_by_role("button", name="结算").click()
        page.wait_for_selector("text=收款 ¥", timeout=5000)
        page.get_by_role("button", name="现金").click()
        page.wait_for_selector("text=现金收款", timeout=5000)
        page.get_by_role("button", name=re.compile("^正好")).click()
        page.get_by_role("button", name=re.compile("^确认收款")).click()
        page.wait_for_selector(".toast", timeout=5000)
        print("    toast:", page.locator(".toast").inner_text())
        page.wait_for_selector("text=收款完成", timeout=5000)
        page.get_by_role("button", name="完成").click()
        page.wait_for_timeout(400)
        shot(page, "03-已收款.png")

        print("[3] 录入进货")
        page.wait_for_selector(".toast", state="detached", timeout=8000)
        page.get_by_role("button", name="进货").click()
        page.wait_for_selector("select", timeout=5000)
        page.locator("select").first.select_option(index=1)
        field_input(page, "数量").fill("3")
        field_input(page, "进价").fill("12")
        shot(page, "04-进货.png")
        page.get_by_role("button", name="保存这一条").click()
        page.wait_for_selector(".toast", timeout=5000)
        ptoast = page.locator(".toast").inner_text()
        print("    toast:", ptoast)
        if "已进货" not in ptoast:
            errors.append(f"进货未成功，toast={ptoast}")

        print("[4] 库存")
        page.get_by_role("button", name="库存").click()
        page.wait_for_selector("text=库存总件数", timeout=5000)
        page.wait_for_timeout(300)
        shot(page, "05-库存.png")

        print("[5] 报表")
        page.get_by_role("button", name="报表").click()
        page.wait_for_selector("text=销售额", timeout=5000)
        page.wait_for_timeout(300)
        revenue = page.locator(".stat").filter(has_text="销售额").locator(".v").inner_text()
        gross = page.locator(".stat").filter(has_text="毛利").locator(".v").inner_text()
        print(f"    销售额={revenue} 毛利={gross}")
        shot(page, "06-报表.png")

        print("[6] 商品管理")
        page.get_by_role("button", name="更多").click()
        page.wait_for_selector("text=商品管理", timeout=5000)
        page.locator(".list-item", has_text="商品管理").click()
        page.wait_for_selector("text=新建", timeout=5000)
        page.wait_for_timeout(300)
        shot(page, "07-商品.png")

        print("[7] 设置")
        page.locator(".back-btn").click()
        page.locator(".list-item", has_text="设置与同步").click()
        page.wait_for_selector("text=导出备份", timeout=5000)
        page.wait_for_timeout(300)
        shot(page, "08-设置.png")

        browser.close()

    if errors:
        print("\n!! 浏览器报错：")
        for e in errors:
            print("   ", e)
        return 1
    print("\nOK：全流程无 console/page 报错")
    return 0


if __name__ == "__main__":
    sys.exit(main())
