"""断网可用性验证：用生产构建（vite preview）验证 Service Worker 缓存，然后断网重载并开一单。
用法（先 pnpm build && pnpm preview --port 4173）：
    python scripts/e2e-offline.py
"""

import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4173/"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "docs", "screenshots", "e2e")
os.makedirs(OUT, exist_ok=True)

errors: list[str] = []


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

        for i in range(60):
            try:
                page.goto(BASE, wait_until="networkidle", timeout=8000)
                break
            except Exception:
                if i == 59:
                    raise
                time.sleep(0.5)

        print("[1] 等待 Service Worker 激活并完成预缓存")
        sw_ok = page.evaluate(
            """async () => {
                const timeout = new Promise((r) => setTimeout(() => r(false), 10000));
                const ready = navigator.serviceWorker.ready.then(() => true).catch(() => false);
                const ok = await Promise.race([ready, timeout]);
                if (!ok) return false;
                if (!navigator.serviceWorker.controller) {
                    await new Promise((res) => {
                        navigator.serviceWorker.addEventListener('controllerchange', res, { once: true });
                        setTimeout(res, 3000);
                    });
                }
                return true;
            }"""
        )
        if not sw_ok:
            errors.append("Service Worker 未就绪")
        # 再给它一点时间把 precache 写完
        page.wait_for_timeout(1500)
        cached = page.evaluate("async () => (await caches.keys()).length")
        print(f"    caches: {cached}")
        page.wait_for_selector("text=大地红 1000 响", timeout=15000)

        print("[2] 切到离线，硬刷新")
        ctx.set_offline(True)
        page.reload(wait_until="domcontentloaded", timeout=15000)
        page.wait_for_selector("text=大地红 1000 响", timeout=15000)
        print("    离线刷新成功，示例商品仍在")
        page.screenshot(path=os.path.join(OUT, "09-离线开单.png"))

        print("[3] 离线开一单")
        page.locator(".prod-btn").first.click()
        page.wait_for_selector(".checkout-bar", timeout=5000)
        page.get_by_role("button", name="结算").click()
        page.wait_for_selector("text=收款 ¥", timeout=5000)
        page.get_by_role("button", name="微信").click()
        page.wait_for_selector(".toast", timeout=5000)
        print("    toast:", page.locator(".toast").inner_text())
        page.wait_for_selector("text=收款完成", timeout=5000)
        page.get_by_role("button", name="完成").click()
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(OUT, "10-离线已收.png"))

        print("[4] 恢复网络，确认数据还在")
        ctx.set_offline(False)
        page.get_by_role("button", name="报表").click()
        page.wait_for_selector("text=销售额", timeout=5000)
        rev = page.locator(".stat").filter(has_text="销售额").locator(".v").inner_text()
        print(f"    销售额={rev}")

        browser.close()

    if errors:
        print("\n!! 浏览器报错：")
        for e in errors:
            print("   ", e)
        return 1
    print("\nOK：断网可用，离线开单成功")
    return 0


if __name__ == "__main__":
    sys.exit(main())
