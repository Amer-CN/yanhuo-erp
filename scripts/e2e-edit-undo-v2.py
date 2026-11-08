"""编辑单 + Toast 撤销验证（进行中场次）。

需先 pnpm build + pnpm preview -- --port 4173。默认禁用云同步。
"""

import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ.get("YH_BASE", "http://localhost:4173/")
SHOT_DIR = Path(os.environ.get("YH_SHOTS", r"E:\Temp\yh-v2"))
SHOT_DIR.mkdir(parents=True, exist_ok=True)


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={"width": 390, "height": 844})
        context.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
        page = context.new_page()
        page.goto(BASE, wait_until="domcontentloaded")
        page.get_by_role("button", name="记一笔").first.wait_for(timeout=25000)

        page.get_by_role("button", name="记一笔").last.click()
        page.get_by_role("button", name="添加商品").first.click()
        page.get_by_role("button", name="大地红 1000 响", exact=False).first.click()
        page.get_by_role("button", name="完成（回单据）").click()
        page.get_by_role("button", name="只保存").click()
        page.get_by_text("¥25.00", exact=False).first.wait_for(timeout=8000)
        page.wait_for_timeout(400)

        # 打开第一单编辑
        page.locator(".glass-list__item").filter(has_text="大地红").first.click()
        page.get_by_text("改这一单").wait_for(timeout=5000)
        amount = page.locator('.record-line input[inputmode="decimal"]').first
        amount.fill("20")
        page.screenshot(path=str(SHOT_DIR / "12-edit-order.png"))
        page.get_by_role("button", name="只保存").click()
        page.get_by_text("¥20.00", exact=False).first.wait_for(timeout=8000)
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOT_DIR / "13-edited-home.png"))

        # Toast 撤销 → 恢复原金额
        page.get_by_role("button", name="撤销").click()
        page.get_by_text("¥25.00", exact=False).first.wait_for(timeout=8000)
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOT_DIR / "14-undone-home.png"))
        assert page.get_by_text("¥20.00", exact=False).count() == 0

        print("OK：编辑单可保存，Toast 撤销能恢复原金额")
        browser.close()
        return 0


if __name__ == "__main__":
    sys.exit(main())