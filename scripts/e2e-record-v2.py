"""v2 场次记账核心流程验证（需先 pnpm build + pnpm preview -- --port 4173）。

覆盖：空态 → 记一笔 → 连续记下一单 → 赠品 → 收摊结账 → 报表 → 补记。
默认禁用云同步，不写线上账本。
"""

import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ.get("YH_BASE", "http://localhost:4173/")
SHOT_DIR = Path(os.environ.get("YH_SHOTS", r"E:\Temp\yh-v2"))
SHOT_DIR.mkdir(parents=True, exist_ok=True)


def shot(page, name: str) -> None:
    page.screenshot(path=str(SHOT_DIR / f"{name}.png"), full_page=False)


def expect_text(page, text: str, timeout: int = 8000) -> None:
    try:
        page.get_by_text(text, exact=False).first.wait_for(timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        dump(page, f"missing-{text[:12]}")
        raise AssertionError(f"找不到文本：{text}") from exc


def dump(page, name: str) -> None:
    out = SHOT_DIR / f"{name}.html"
    out.write_text(page.content(), encoding="utf-8")
    print(f"已保存 DOM：{out}")


def add_product(page, name: str) -> None:
    page.get_by_role("button", name=name, exact=False).first.click()
    page.wait_for_timeout(150)


def close_picker_if_open(page) -> None:
    """保存后自动重开的「选商品」弹层会挡住页面按钮，存在且可见才关掉。"""
    finish = page.get_by_role("button", name="完成（回单据）")
    if finish.count() > 0 and finish.first.is_visible():
        finish.first.click()
        page.wait_for_timeout(300)


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={"width": 390, "height": 844})
        context.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
        page = context.new_page()
        page.on("pageerror", lambda e: print(f"[pageerror] {e}"))

        page.goto(BASE, wait_until="domcontentloaded")
        page.get_by_role("button", name="记一笔").first.wait_for(timeout=25000)
        expect_text(page, "还没开张")
        shot(page, "01-home-empty")

        # 第一单：两种商品
        page.get_by_role("button", name="记一笔").last.click()
        page.get_by_role("button", name="添加商品").first.wait_for(timeout=5000)
        page.get_by_role("button", name="添加商品").first.click()
        expect_text(page, "选商品")
        add_product(page, "大地红 1000 响")
        add_product(page, "二踢脚")
        shot(page, "02-picker-added")
        page.get_by_role("button", name="完成（回单据）").click()
        expect_text(page, "成交金额")
        shot(page, "03-editor-first")
        page.get_by_role("button", name="保存并记下一单").click()
        expect_text(page, "已记 1 单")
        page.wait_for_timeout(400)

        # 第二单：赠品，保存后继续。上一单保存后弹层已自动重开，先关掉再点「添加商品」
        close_picker_if_open(page)
        page.get_by_role("button", name="添加商品").first.click()
        add_product(page, "摔炮")
        page.get_by_role("button", name="完成（回单据）").click()
        page.get_by_label("赠品", exact=False).first.check()
        expect_text(page, "成本结账时")
        shot(page, "04-editor-gift")
        page.get_by_role("button", name="保存并记下一单").click()
        expect_text(page, "已记 1 单")
        page.wait_for_timeout(400)
        # 连续开单自动重开的弹层会挡住开单页的「返回」，先关掉
        close_picker_if_open(page)
        page.get_by_role("button", name="返回").click()
        page.wait_for_timeout(400)

        expect_text(page, "已记 2 单")
        expect_text(page, "¥26.50")
        shot(page, "05-home-two-orders")

        # 收摊结账
        page.get_by_role("button", name="收摊结账").first.click()
        expect_text(page, "结账前看一眼")
        page.wait_for_timeout(450)
        shot(page, "06-close-preview")
        page.get_by_role("button", name="确认收摊结账").click()
        expect_text(page, "本场已结账")
        page.wait_for_timeout(450)
        shot(page, "07-close-result")
        page.get_by_role("button", name="完成").click()
        page.wait_for_timeout(500)
        expect_text(page, "还没开张")
        shot(page, "08-home-after-close")

        # 报表（本场回退到最近已结账场次）
        page.get_by_role("button", name="报表").click()
        expect_text(page, "销售额")
        expect_text(page, "赠品成本")
        shot(page, "09-report-history")

        # 补记到这一场
        page.get_by_role("button", name="补记到这一场").first.click()
        expect_text(page, "补记一笔")
        page.get_by_role("button", name="添加商品").first.click()
        add_product(page, "仙女棒")
        page.get_by_role("button", name="完成（回单据）").click()
        page.get_by_role("button", name="只保存").click()
        expect_text(page, "已记 1 单")
        page.wait_for_timeout(600)
        expect_text(page, "补过 1 单")
        page.wait_for_timeout(450)
        shot(page, "10-report-patched")

        print("OK：v2 记账主流程通过")
        print(f"截图目录：{SHOT_DIR}")
        browser.close()
        return 0


if __name__ == "__main__":
    sys.exit(main())
