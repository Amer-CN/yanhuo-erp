"""两台设备自动云同步端到端验证（不需要真的 Supabase）。

用法（先 pnpm dev）：
    python scripts/e2e-sync.py
"""

import os
import re
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE = os.environ.get("SYNC_TEST_BASE", "http://127.0.0.1:5173/")
PORT = 54321
MOCK = os.path.join(ROOT, "scripts", "mock-supabase.mjs")
OUT = os.path.join(ROOT, "docs", "screenshots", "e2e")
os.makedirs(OUT, exist_ok=True)

errors: list[str] = []


def init_script():
    return f"""
      localStorage.setItem('yh-sync-url', 'http://127.0.0.1:{PORT}');
      localStorage.setItem('yh-sync-anon', 'test-anon-key');
      localStorage.setItem('yh-sync-ledger', 'test-ledger-2026');
    """


def new_page(browser, tag):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=2,
        locale="zh-CN",
        timezone_id="Asia/Shanghai",
    )
    ctx.add_init_script(init_script())
    page = ctx.new_page()
    page.on(
        "console",
        lambda m: errors.append(f"[{tag}] console.{m.type}: {m.text}") if m.type == "error" else None,
    )
    page.on("pageerror", lambda e: errors.append(f"[{tag}] pageerror: {e}"))
    for i in range(40):
        try:
            page.goto(BASE, wait_until="networkidle", timeout=8000)
            break
        except Exception:
            if i == 39:
                raise
            time.sleep(0.5)
    page.wait_for_selector("text=大地红 1000 响", timeout=20000)
    return ctx, page


def sell(page, idx: int, pay="现金"):
    page.get_by_role("button", name="开单").click()
    page.wait_for_selector(".prod-btn", timeout=5000)
    page.locator(".prod-btn").nth(idx).click()
    page.wait_for_selector(".checkout-bar", timeout=5000)
    page.get_by_role("button", name="结算").click()
    page.wait_for_selector("text=收款 ¥", timeout=5000)
    page.get_by_role("button", name=pay).click()
    if pay == "现金":
        page.wait_for_selector("text=现金收款", timeout=5000)
        page.get_by_role("button", name=re.compile("^正好")).click()
        page.get_by_role("button", name=re.compile("^确认收款")).click()
    page.wait_for_selector("text=收款完成", timeout=5000)
    page.get_by_role("button", name="完成").click()
    page.wait_for_timeout(500)


def revenue(page) -> str:
    page.get_by_role("button", name="报表").click()
    page.wait_for_selector("text=销售额", timeout=5000)
    return page.locator(".stat").filter(has_text="销售额").locator(".v").inner_text()


def wait_revenue(page, want: str, timeout=30) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        v = revenue(page)
        if want in v:
            return True
        page.wait_for_timeout(1000)
    return False


def main() -> int:
    mock = subprocess.Popen(
        ["node", MOCK, str(PORT)],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    time.sleep(1.0)
    if mock.poll() is not None:
        print("mock server failed:", mock.stdout.read() if mock.stdout else "")
        return 1

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx_a, a = new_page(browser, "A")
            ctx_b, b = new_page(browser, "B")
            print("[1] 两台设备已带同一个同步码启动")

            print("[2] A 卖一单，等 B 自动看到（不导出/导入）")
            sell(a, 0)
            seen = wait_revenue(b, "¥25.00", timeout=35)
            print("    B 报表销售额：", revenue(b), "->", "OK" if seen else "TIMEOUT")
            if not seen:
                errors.append("B 没有自动拉到 A 的销售")
            b.screenshot(path=os.path.join(OUT, "20-同步-B看到A的单.png"))

            print("[3] B 卖一单，等 A 自动看到")
            sell(b, 1)
            seen2 = wait_revenue(a, "¥26.50", timeout=35)
            print("    A 报表销售额：", revenue(a), "->", "OK" if seen2 else "TIMEOUT")
            if not seen2:
                errors.append("A 没有自动拉到 B 的销售")
            a.screenshot(path=os.path.join(OUT, "21-同步-A看到两单.png"))

            print("[4] B 断网再卖一单，恢复网络后 A 自动收到")
            ctx_b.set_offline(True)
            sell(b, 2)  # 加特林 ¥15
            local_seen = wait_revenue(b, "¥41.50", timeout=8)
            print("    B 本地报表：", revenue(b), "->", "OK" if local_seen else "TIMEOUT")
            if not local_seen:
                errors.append("B 离线时本地没有记上这一单")
            a_now = revenue(a)
            print("    断网期间 A 报表：", a_now)
            ctx_b.set_offline(False)
            seen3 = wait_revenue(a, "¥41.50", timeout=45)
            print("    恢复网络后 A 报表：", revenue(a), "->", "OK" if seen3 else "TIMEOUT")
            if not seen3:
                errors.append("B 恢复网络后 A 没有自动收到补发的单")
            a.screenshot(path=os.path.join(OUT, "22-同步-离线补发.png"))

            ctx_a.close()
            ctx_b.close()
            browser.close()
    finally:
        mock.terminate()
        try:
            mock.wait(timeout=5)
        except subprocess.TimeoutExpired:
            mock.kill()

    if errors:
        print("\n!! 问题：")
        for e in errors:
            print("   ", e)
        return 1
    print("\nOK：两台设备自动同步，无需手动导出/导入")
    return 0


if __name__ == "__main__":
    sys.exit(main())