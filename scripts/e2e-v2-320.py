"""320px 窄屏检查：首页 / 单据编辑 / 结账 Sheet / 报表无横向溢出。

需先 pnpm build + pnpm preview -- --port 4173。
"""

import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ.get("YH_BASE", "http://localhost:4173/")
SHOT_DIR = Path(os.environ.get("YH_SHOTS", r"E:\Temp\yh-v2"))
SHOT_DIR.mkdir(parents=True, exist_ok=True)


def assert_no_overflow(page, where: str) -> None:
    metrics = page.evaluate(
        "() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })"
    )
    if metrics["sw"] > metrics["iw"] + 1:
        raise AssertionError(f"{where} 出现横向溢出：scrollWidth={metrics['sw']} viewport={metrics['iw']}")
    print(f"{where}: scrollWidth={metrics['sw']} viewport={metrics['iw']} OK")


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={"width": 320, "height": 700})
        context.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
        page = context.new_page()
        page.goto(BASE, wait_until="domcontentloaded")
        page.get_by_role("button", name="记一笔").first.wait_for(timeout=25000)
        assert_no_overflow(page, "首页")
        page.screenshot(path=str(SHOT_DIR / "15-320-home.png"))

        page.get_by_role("button", name="记一笔").last.click()
        page.get_by_role("button", name="添加商品").first.click()
        page.get_by_role("button", name="大地红 1000 响", exact=False).first.click()
        page.get_by_role("button", name="完成（回单据）").click()
        assert_no_overflow(page, "单据编辑")
        page.screenshot(path=str(SHOT_DIR / "16-320-editor.png"))

        page.get_by_role("button", name="只保存").click()
        page.get_by_text("已记 1 单", exact=False).first.wait_for(timeout=8000)
        page.wait_for_timeout(400)
        page.get_by_role("button", name="收摊结账").first.click()
        page.get_by_text("结账前看一眼").wait_for(timeout=5000)
        page.wait_for_timeout(450)
        assert_no_overflow(page, "收摊结账")
        page.screenshot(path=str(SHOT_DIR / "17-320-close.png"))
        page.get_by_role("button", name="关闭").click()
        page.wait_for_timeout(400)

        page.get_by_role("button", name="报表").click()
        page.get_by_text("销售额", exact=False).first.wait_for(timeout=8000)
        assert_no_overflow(page, "报表")
        page.screenshot(path=str(SHOT_DIR / "18-320-report.png"))

        print("OK：320px 无横向溢出")
        browser.close()
        return 0


if __name__ == "__main__":
    sys.exit(main())