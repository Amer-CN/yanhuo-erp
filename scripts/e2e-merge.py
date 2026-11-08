"""两设备合并验证：A 开单后导出，B 导入合并，检查不重复、金额相加。
用法（先 pnpm build && pnpm preview --port 4173）：
    python scripts/e2e-merge.py
"""

import os
import re
import sys
import tempfile
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:4173/"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "docs", "screenshots", "e2e")
os.makedirs(OUT, exist_ok=True)

errors: list[str] = []


def ctx_of(browser, tag: str):
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
        lambda m: errors.append(f"[{tag}] console.{m.type}: {m.text}") if m.type == "error" else None,
    )
    page.on("pageerror", lambda e: errors.append(f"[{tag}] pageerror: {e}"))
    return ctx, page


def wait_app(page):
    for i in range(60):
        try:
            page.goto(BASE, wait_until="networkidle", timeout=8000)
            break
        except Exception:
            if i == 59:
                raise
            time.sleep(0.5)
    page.wait_for_selector("text=大地红 1000 响", timeout=20000)


def sell_product(page, idx: int, pay="现金"):
    page.locator(".prod-btn").nth(idx).click()
    page.wait_for_selector(".checkout-bar", timeout=5000)
    page.get_by_role("button", name="结算").click()
    page.wait_for_selector("text=收款 ¥", timeout=5000)
    page.get_by_role("button", name=pay).click()
    if pay == "现金":
        page.wait_for_selector("text=现金收款", timeout=5000)
        page.get_by_role("button", name=re.compile("^正好")).click()
        page.get_by_role("button", name=re.compile("^确认收款")).click()
    page.wait_for_selector(".toast", timeout=5000)
    text = page.locator(".toast").inner_text()
    page.wait_for_selector("text=收款完成", timeout=5000)
    page.get_by_role("button", name="完成").click()
    page.wait_for_selector(".toast", state="detached", timeout=8000)
    return text


def main() -> int:
    tmpdir = tempfile.mkdtemp(prefix="yanhuo-merge-")
    backup_path = os.path.join(tmpdir, "backup.json")

    with sync_playwright() as p:
        browser = p.chromium.launch()

        # ---------------- 设备 A ----------------
        ctx_a, a = ctx_of(browser, "A")
        wait_app(a)
        print("[A] 卖出第一个商品：", sell_product(a, 0))

        a.get_by_role("button", name="更多").click()
        a.wait_for_selector("text=设置与同步", timeout=5000)
        a.locator(".list-item", has_text="设置与同步").click()
        a.wait_for_selector("text=导出备份", timeout=5000)
        with a.expect_download() as dl:
            a.get_by_role("button", name="导出备份").click()
        dl.value.save_as(backup_path)
        print(f"[A] 已导出备份 {os.path.getsize(backup_path)} bytes")
        a.screenshot(path=os.path.join(OUT, "11-A设备.png"))

        # ---------------- 设备 B ----------------
        ctx_b, b = ctx_of(browser, "B")
        wait_app(b)
        print("[B] 卖出第二个商品：", sell_product(b, 1))

        b.get_by_role("button", name="更多").click()
        b.wait_for_selector("text=设置与同步", timeout=5000)
        b.locator(".list-item", has_text="设置与同步").click()
        b.wait_for_selector("text=导入并合并", timeout=5000)
        b.set_input_files("input[type=file]", backup_path)
        b.wait_for_selector("text=确认合并", timeout=10000)
        b.screenshot(path=os.path.join(OUT, "13-合并预览.png"))
        b.get_by_role("button", name="合并这些数据").click()
        b.wait_for_selector(".toast", timeout=10000)
        toast = b.locator(".toast").inner_text()
        print("[B] 合并结果 toast：", toast)
        if "合并完成" not in toast:
            errors.append(f"合并失败：{toast}")

        b.wait_for_selector("text=合并完成", timeout=8000)
        b.get_by_role("button", name="完成").click()
        b.wait_for_selector(".toast", state="detached", timeout=8000)

        # 检查商品没重复：回「更多」看商品数量
        b.locator(".back-btn").click()
        b.wait_for_selector("text=商品管理", timeout=5000)
        more_text = b.locator(".list-item", has_text="商品管理").inner_text()
        print("[B] 商品管理行：", more_text.replace("\n", " / "))
        if "共 8 个商品" not in more_text:
            errors.append(f"示例商品合并后重复了：{more_text}")

        # 全部销售额应该是 A(25.00) + B(1.50) = 26.50
        b.get_by_role("button", name="报表").click()
        b.wait_for_selector("text=销售额", timeout=5000)
        b.get_by_role("button", name="全部").click()
        b.wait_for_timeout(400)
        rev = b.locator(".stat").filter(has_text="销售额").locator(".v").inner_text()
        cnt = b.locator(".stat").filter(has_text="单数").locator(".v").inner_text()
        print(f"[B] 合并后 全部销售额={rev} 单数={cnt}")
        if "26.50" not in rev:
            errors.append(f"合并后销售额不对：{rev}（应 26.50）")
        b.screenshot(path=os.path.join(OUT, "12-B设备-合并后.png"))

        ctx_a.close()
        ctx_b.close()
        browser.close()

    if errors:
        print("\n!! 问题：")
        for e in errors:
            print("   ", e)
        return 1
    print("\nOK：两设备合并正确，无重复、金额相加")
    return 0


if __name__ == "__main__":
    sys.exit(main())

