"""端到端冒烟测试（v2 场次记账）：开单 → 进货 → 库存 → 报表 → 商品 → 设置。
用法（先 pnpm dev）：
    python scripts/e2e-smoke.py
"""

import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright

BASE = os.environ.get("SMOKE_BASE", "http://127.0.0.1:5173/")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "docs", "screenshots", "e2e")
os.makedirs(OUT, exist_ok=True)

errors: list[str] = []


def shot(page, name: str) -> None:
    page.screenshot(path=os.path.join(OUT, name))
    print(f"  screenshot -> docs/screenshots/e2e/{name}")


def expect_text(page, text: str, timeout: int = 8000) -> None:
    try:
        page.get_by_text(text, exact=False).first.wait_for(timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        shot(page, f"FAIL-{text[:12]}.png")
        errors.append(f"找不到文本：{text}")
        raise AssertionError(f"找不到文本：{text}") from exc


def add_product(page, name: str) -> None:
    page.get_by_role("button", name=name, exact=False).first.click()
    page.wait_for_timeout(150)


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
        ctx.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
        page.on(
            "console",
            lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None,
        )
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        page.goto(BASE, wait_until="networkidle")
        print("[1] 首屏")
        page.get_by_role("button", name="记一笔").last.wait_for(timeout=25000)
        expect_text(page, "还没开张")
        shot(page, "01-首屏.png")

        print("[2] 记一笔（两种商品）")
        page.get_by_role("button", name="记一笔").last.click()
        page.get_by_role("button", name="添加商品").first.wait_for(timeout=5000)
        page.get_by_role("button", name="添加商品").first.click()
        expect_text(page, "选商品")
        add_product(page, "大地红 1000 响")
        add_product(page, "二踢脚")
        page.get_by_role("button", name="完成（回单据）").click()
        expect_text(page, "成交金额")
        shot(page, "02-记一笔.png")
        page.get_by_role("button", name="保存并记下一单").click()
        expect_text(page, "已记 1 单")
        page.wait_for_timeout(400)
        page.get_by_role("button", name="返回").click()
        page.wait_for_timeout(400)
        expect_text(page, "¥26.50")
        shot(page, "03-已记一单.png")

        print("[3] 进货")
        page.get_by_role("button", name="进货").click()
        page.wait_for_selector("select", timeout=5000)
        page.locator("select").first.select_option(index=1)
        page.get_by_label("数量", exact=False).fill("3")
        page.get_by_label("进价", exact=False).fill("12")
        shot(page, "04-进货.png")
        page.get_by_role("button", name="保存这一条").click()
        page.wait_for_selector(".toast", timeout=5000)
        ptoast = page.locator(".toast").inner_text()
        print("    toast:", ptoast)
        if "已进货" not in ptoast:
            errors.append(f"进货未成功，toast={ptoast}")

        print("[4] 库存")
        page.get_by_role("button", name="库存").click()
        expect_text(page, "库存总件数")
        page.wait_for_timeout(300)
        shot(page, "05-库存.png")

        print("[5] 报表")
        page.get_by_role("button", name="报表").click()
        expect_text(page, "销售额")
        expect_text(page, "¥26.50")
        page.wait_for_timeout(300)
        shot(page, "06-报表.png")

        print("[6] 商品管理")
        page.get_by_role("button", name="更多").click()
        expect_text(page, "商品管理")
        page.locator(".list-item", has_text="商品管理").click()
        expect_text(page, "新建")
        page.wait_for_timeout(300)
        shot(page, "07-商品.png")

        print("[7] 设置")
        page.locator(".back-btn").click()
        page.locator(".list-item", has_text="设置与同步").click()
        expect_text(page, "导出备份")
        page.wait_for_timeout(300)
        shot(page, "08-设置.png")

        browser.close()

    if errors:
        print("\n!! 浏览器报错：")
        for e in errors:
            print("   ", e)
        return 1
    print("\nOK：v2 开单/进货/库存/报表/设置全流程通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())