"""断网可用性验证（v2 场次记账）：生产构建 + Service Worker → 断网重载 → 离线记一笔。
用法（先 pnpm build && pnpm preview -- --port 4173）：
    python scripts/e2e-offline.py
"""

import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright

from e2e_util import wait_for_save_receipt

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4173/"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "docs", "screenshots", "e2e")
os.makedirs(OUT, exist_ok=True)

errors: list[str] = []


def wait_home(page, timeout: int = 15000) -> None:
    page.get_by_role("button", name="记一笔").last.wait_for(timeout=timeout)


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
        page.wait_for_timeout(1500)
        cached = page.evaluate("async () => (await caches.keys()).length")
        print(f"    caches: {cached}")
        wait_home(page)

        print("[2] 切到离线，硬刷新")
        ctx.set_offline(True)
        page.reload(wait_until="domcontentloaded", timeout=15000)
        wait_home(page)
        print("    离线刷新成功")
        page.screenshot(path=os.path.join(OUT, "09-离线首屏.png"))

        print("[3] 离线记一笔")
        page.get_by_role("button", name="记一笔").last.click()
        page.get_by_role("button", name="添加商品").first.wait_for(timeout=5000)
        page.get_by_role("button", name="添加商品").first.click()
        page.get_by_role("button", name="大地红 1000 响").first.click()
        page.get_by_role("button", name="完成（回单据）").click()
        page.get_by_role("button", name="保存并记下一单").click()
        # 2026-11-12（P3）：连续开单的回执改成开单页底栏的内联一行（.record-receipt），
        # 不再走浮层 Toast（Toast 会压住自动弹开的选商品层标题）。
        # P4 顺带把离线态写进同一句文案：断网时应含「· 待联网上传」。
        receipt = wait_for_save_receipt(page, "已记")
        print("    receipt:", receipt)
        if receipt is None:
            errors.append("离线记一笔后没有出现「已记」回执")
        elif "待联网上传" not in receipt:
            errors.append(f"离线回执没有提示待上传：{receipt}")
        page.screenshot(path=os.path.join(OUT, "10-离线已记.png"))
        # 自动重开的选商品层 600ms 后才弹（P1），等它出现再关
        page.wait_for_selector(".glass-sheet", timeout=5000)
        page.wait_for_timeout(400)
        # 「保存并记下一单」会顺带重开选商品弹层（连续开单设计，RecordEditor.tsx
        # 里 setPickOpen(true)），弹层遮罩会挡住开单页的「返回」，先关掉再返回。
        # 用「存在且可见才点」而不是固定等待，避免以后 UI 再变就误报超时。
        finish = page.get_by_role("button", name="完成（回单据）")
        if finish.count() > 0 and finish.first.is_visible():
            finish.first.click()
            page.wait_for_timeout(300)
        page.get_by_role("button", name="返回").click()
        page.wait_for_timeout(400)
        page.wait_for_selector("text=¥25.00", timeout=5000)
        page.screenshot(path=os.path.join(OUT, "10b-离线回首页.png"))

        print("[4] 恢复网络，确认数据还在")
        ctx.set_offline(False)
        page.wait_for_timeout(1000)
        page.wait_for_selector("text=¥25.00", timeout=5000)
        page.wait_for_selector("text=本场已记 1 单", timeout=5000)
        page.screenshot(path=os.path.join(OUT, "11-离线恢复网络.png"))

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