"""主动巡检修复批 1 的实测脚本（P1/P2/P3/P4/P6/P8/P10）。

用法（先 pnpm dev，默认 dev server 在 5173）：
    python scripts/ux-probe-20261112/verify-fix-batch1.py

只读真实 UI：每个用例都走「用户会点的路径」，断言值全部来自 DOM，
截图落在 docs/screenshots/proactive-fix/。最后打印一段 JSON 便于贴交付报告。
"""

from __future__ import annotations

import json
import os
import sys
import traceback

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import Page, sync_playwright

BASE = os.environ.get("VERIFY_BASE", "http://127.0.0.1:5173/")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "docs", "screenshots", "proactive-fix")
os.makedirs(OUT, exist_ok=True)

RESULT: dict[str, dict] = {}
CONSOLE_ERRORS: list[str] = []

VIEW_W, VIEW_H = 390, 844
LOWER_THIRD = VIEW_H * 2 / 3  # 562.67：P8 的「下 1/3」门槛


def shot(page: Page, name: str) -> None:
    page.screenshot(path=os.path.join(OUT, name))
    print(f"  screenshot -> docs/screenshots/proactive-fix/{name}")


def tab(page: Page, name: str) -> None:
    page.get_by_role("button", name=name).first.click()
    page.wait_for_timeout(350)


def open_editor(page: Page) -> None:
    page.get_by_role("button", name="记一笔").last.click()
    page.get_by_role("button", name="添加商品").first.wait_for(timeout=8000)
    page.wait_for_timeout(150)


def field_hint(page: Page, label_part: str) -> str:
    grp = page.locator(".glass-input-group").filter(has_text=label_part).first
    hint = grp.locator(".glass-hint")
    return hint.first.inner_text().strip() if hint.count() else ""


def home_record_count(page: Page) -> str:
    loc = page.locator(".checkout-dock__total .k").first
    return loc.inner_text().strip()


def p1_rapid_taps(page: Page) -> None:
    """P1：0.1s 连点 5 次「保存并记下一单」→ 只记 1 单、不多加商品。"""
    out: dict = {}
    tab(page, "记账")
    open_editor(page)
    page.get_by_role("button", name="添加商品").first.click()
    page.get_by_role("button", name="摔炮", exact=False).first.click()
    page.get_by_role("button", name="完成（回单据）").click()
    page.wait_for_timeout(200)

    btn = page.get_by_role("button", name="保存并记下一单")
    box = btn.bounding_box()
    assert box, "找不到保存按钮的位置"
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    out["tap_xy"] = [round(cx), round(cy)]

    # 用鼠标在**固定坐标**上连点：模拟手指不移动位置地连点，落点由页面决定
    for _ in range(5):
        page.mouse.click(cx, cy)
        page.wait_for_timeout(120)

    # 600ms 延迟开层 + 400ms 入场锁之后再看结果
    page.wait_for_timeout(1600)
    out["sheet_count"] = page.locator(".glass-sheet").count()
    sub = page.locator(".glass-sheet__subtitle").first
    out["picker_subtitle"] = sub.inner_text().strip() if sub.count() else None
    out["added_cards"] = page.locator(".prod-btn.is-added").count()
    out["receipt"] = (
        page.locator(".record-receipt__text").first.inner_text().strip()
        if page.locator(".record-receipt__text").count()
        else None
    )
    out["toast_count"] = page.locator(".toast").count()
    out["toast_text"] = (
        page.locator(".toast").first.inner_text().strip() if out["toast_count"] else None
    )
    shot(page, "P1-after-5taps.png")

    # 回首页看真实落库结果
    finish = page.get_by_role("button", name="完成（回单据）")
    if finish.count() and finish.first.is_visible():
        finish.first.click()
        page.wait_for_timeout(400)
    confirm = page.get_by_role("button", name="离开")  # 有商品行时返回会弹确认框
    has_confirm = confirm.count() > 0 and confirm.first.is_visible()
    out["leave_confirm"] = has_confirm
    if has_confirm:
        shot(page, "P1-unexpected-lines.png")
        confirm.first.click()
        page.wait_for_timeout(400)
    page.get_by_role("button", name="返回").click()
    page.wait_for_timeout(600)

    out["home_count_text"] = home_record_count(page)
    out["home_summaries"] = [
        t.strip() for t in page.locator(".glass-list__subtitle").all_inner_texts()
    ]
    shot(page, "P1-home.png")
    RESULT["P1"] = out


def p2_purchase_qty(page: Page) -> None:
    """P2：进货数量 1.5 / ０７ / 99999 的框内最终值与提示。"""
    out: dict = {}
    tab(page, "进货")
    page.wait_for_selector("select", timeout=8000)
    page.locator("select").first.select_option(index=1)
    page.wait_for_timeout(200)
    qty = page.get_by_label("数量", exact=False).first
    for case in ["1.5", "０７", "99999"]:
        qty.fill(case)
        page.wait_for_timeout(200)
        out[case] = {"box": qty.input_value(), "hint": field_hint(page, "数量（")}
    shot(page, "P2-purchase-qty.png")
    RESULT["P2_purchase"] = out


def p2_stock_adjust(page: Page) -> None:
    """P2：盘亏数量 1.5 / ０７ / 99999 的框内最终值与提示。"""
    out: dict = {}
    tab(page, "库存")
    page.locator(".list-item").first.click()
    page.wait_for_timeout(400)
    qty = page.get_by_label("调整数量", exact=False).first
    # 先填一个合法值：小数被拒时要能看出「回退到原值」而不是清空
    qty.fill("3")
    page.wait_for_timeout(150)
    for case in ["1.5", "０７", "99999"]:
        qty.fill(case)
        page.wait_for_timeout(200)
        out[case] = {"box": qty.input_value(), "hint": field_hint(page, "调整数量")}
    shot(page, "P2-stock-adjust.png")
    page.get_by_role("button", name="关闭").first.click()
    page.wait_for_timeout(400)
    RESULT["P2_stock"] = out


def p3_picker_title(page: Page) -> None:
    """P3：连续开 3 单，弹层标题完整可见（且不再有浮层 Toast）。"""
    out: dict = {"orders": []}
    tab(page, "记账")
    for i in range(3):
        open_editor(page)
        page.get_by_role("button", name="添加商品").first.click()
        page.get_by_role("button", name="摔炮", exact=False).first.click()
        page.get_by_role("button", name="完成（回单据）").click()
        page.wait_for_timeout(150)
        page.get_by_role("button", name="保存并记下一单").click()
        page.wait_for_timeout(800)  # 比 600ms 延迟开层多一点
        title = page.locator(".glass-sheet__title").first
        rect = title.bounding_box() if title.count() else None
        rec = page.locator(".record-receipt__text").first
        receipt_box = page.locator(".record-receipt").first.bounding_box() if page.locator(".record-receipt").count() else None
        panel_box = page.locator(".glass-sheet").first.bounding_box()
        toast_box = page.locator(".toast").first.bounding_box() if page.locator(".toast").count() else None

        def overlap(a, b):
            """两个矩形的相交面积（无交集返回 0）"""
            if not a or not b:
                return 0
            w = min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"])
            h = min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"])
            return round(max(0, w) * max(0, h))

        out["orders"].append(
            {
                "step": i + 1,
                "title": title.inner_text().strip() if title.count() else None,
                "title_rect": {k: round(v) for k, v in rect.items()} if rect else None,
                "title_fully_visible": bool(rect)
                and rect["y"] >= 0
                and rect["y"] + rect["height"] <= VIEW_H,
                "toast_count": page.locator(".toast").count(),
                "receipt": rec.inner_text().strip() if rec.count() else None,
                "receipt_rect": {k: round(v) for k, v in receipt_box.items()} if receipt_box else None,
                "panel_rect": {k: round(v) for k, v in panel_box.items()} if panel_box else None,
                "toast_rect": {k: round(v) for k, v in toast_box.items()} if toast_box else None,
                # 关键断言：谁都不许压住标题。浮层 Toast 为 0，回执在底栏（z=900 < 弹层 1000）
                "title_x_toast_area": overlap(rect, toast_box),
                "title_x_receipt_area": overlap(rect, receipt_box),
                # 回执在弹层矩形之内（底栏被面板盖住）——记录数值，说明是「在下面」而不是「压在上面」
                "receipt_x_panel_area": overlap(receipt_box, panel_box),
            }
        )
        if i == 0:
            shot(page, "P3-picker-title.png")
        page.get_by_role("button", name="完成（回单据）").click()
        page.wait_for_timeout(300)
        page.get_by_role("button", name="返回").click()
        page.wait_for_timeout(500)
    shot(page, "P3-home-3orders.png")
    RESULT["P3"] = out


def p4_offline(page: Page) -> None:
    """P4：断网进开单页 → 离线徽标；保存 → 回执含「待联网上传」。"""
    out: dict = {}
    tab(page, "记账")
    page.context.set_offline(True)
    page.wait_for_timeout(600)
    open_editor(page)
    badge = page.locator(".record-offline").first
    out["badge_visible"] = badge.is_visible() if badge.count() else False
    out["badge_text"] = badge.inner_text().strip() if badge.count() else None
    out["badge_aria"] = badge.get_attribute("aria-label") if badge.count() else None
    shot(page, "P4-offline-editor.png")

    page.get_by_role("button", name="添加商品").first.click()
    page.get_by_role("button", name="摔炮", exact=False).first.click()
    page.get_by_role("button", name="完成（回单据）").click()
    page.wait_for_timeout(150)
    page.get_by_role("button", name="保存并记下一单").click()
    # 回执在保存完成瞬间就出现，而选商品层要 600ms 后才弹（P1），
    # 所以这里先抢一张「底栏回执 + 离线徽标」都露在外面的截图。
    page.wait_for_timeout(320)
    shot(page, "P4-receipt-offline.png")
    page.wait_for_timeout(500)
    rec = page.locator(".record-receipt__text").first
    out["receipt"] = rec.inner_text().strip() if rec.count() else None
    shot(page, "P4-receipt-offline-sheet.png")

    page.get_by_role("button", name="完成（回单据）").click()
    page.wait_for_timeout(300)
    page.get_by_role("button", name="返回").click()
    page.wait_for_timeout(400)
    page.context.set_offline(False)
    page.wait_for_timeout(500)
    RESULT["P4"] = out


def p6_negative_cost(page: Page) -> None:
    """P6：进价 -5 → 红字拦截、不落库。"""
    out: dict = {}
    tab(page, "进货")
    page.wait_for_selector("select", timeout=8000)
    before = page.locator(".glass-list__title", has_text="今天已录").first.inner_text().strip()
    page.locator("select").first.select_option(index=1)
    page.get_by_label("数量", exact=False).first.fill("1")
    page.get_by_label("进价", exact=False).first.fill("-5")
    page.wait_for_timeout(150)
    page.get_by_role("button", name="保存这一条").click()
    page.wait_for_timeout(500)
    out["error_text"] = field_hint(page, "进价")
    out["before"] = before
    out["after"] = page.locator(".glass-list__title", has_text="今天已录").first.inner_text().strip()
    out["toast"] = (
        page.locator(".toast").first.inner_text().strip() if page.locator(".toast").count() else None
    )
    shot(page, "P6-negative-cost.png")
    RESULT["P6"] = out


def p8_add_button(page: Page) -> None:
    """P8：新增的「添加商品」入口中心 y 要进下 1/3（>562）。"""
    out: dict = {}
    tab(page, "记账")
    open_editor(page)
    page.get_by_role("button", name="添加商品").first.click()
    page.get_by_role("button", name="摔炮", exact=False).first.click()
    page.get_by_role("button", name="完成（回单据）").click()
    page.wait_for_timeout(300)

    buttons = page.get_by_role("button", name="添加商品")
    out["entry_count"] = buttons.count()
    boxes = []
    for i in range(buttons.count()):
        b = buttons.nth(i).bounding_box()
        if b:
            boxes.append(
                {"index": i, "center_y": round(b["y"] + b["height"] / 2), "bottom": round(b["y"] + b["height"])}
            )
    out["entries"] = boxes
    out["lower_third_start"] = round(LOWER_THIRD)
    out["new_entry_center_y"] = boxes[-1]["center_y"] if boxes else None
    out["in_lower_third"] = bool(boxes) and boxes[-1]["center_y"] > LOWER_THIRD

    # 光有坐标不够：底栏是 fixed 覆盖层，按钮可能「看得见点不到」。
    # 命中测试：圆心那一点的最上层元素必须就是这个按钮自己。
    dock = page.locator(".record-actions").first.bounding_box()
    out["dock_top"] = round(dock["y"]) if dock else None
    last = buttons.last
    b = last.bounding_box()
    if b:
        hit = page.evaluate(
            """([x, y]) => {
                const el = document.elementFromPoint(x, y);
                const btn = el && el.closest('button');
                return btn ? btn.textContent.trim() : (el ? el.tagName : null);
            }""",
            [b["x"] + b["width"] / 2, b["y"] + b["height"] / 2],
        )
        out["hit_test"] = hit
        out["hittable"] = hit is not None and "添加商品" in str(hit)
    shot(page, "P8-add-entry.png")
    page.get_by_role("button", name="返回").click()
    page.wait_for_timeout(300)
    page.get_by_role("button", name="离开").click()
    page.wait_for_timeout(400)
    RESULT["P8"] = out


def p10_negative_stock(page: Page) -> None:
    """P10：造一条负库存，顶卡数字与列表一致（净件数）。"""
    out: dict = {}
    tab(page, "库存")
    # 找一个账面为 0 的商品做盘亏（列表第一条就是按 sortOrder 排的示例商品）
    first_name = page.locator(".glass-list__title").first.inner_text().strip()
    page.locator(".list-item").first.click()
    page.wait_for_timeout(400)
    page.get_by_label("调整数量", exact=False).first.fill("5")
    page.get_by_role("button", name="记一笔调整").click()
    page.wait_for_timeout(700)
    out["product"] = first_name

    card = page.locator(".stat").first
    out["card_label"] = card.locator(".k").inner_text().strip()
    out["card_value"] = card.locator(".v").inner_text().strip()
    out["card_note"] = (
        page.locator(".stat-sub").first.inner_text().strip()
        if page.locator(".stat-sub").count()
        else None
    )
    subs = [t.strip() for t in page.locator(".glass-list__subtitle").all_inner_texts()]
    out["list_subtitles"] = subs
    nums = []
    for s in subs:
        # 形如「库存 12 挂」「库存 -5 挂 · 负库存」
        digits = "".join(ch if (ch.isdigit() or ch == "-") else " " for ch in s).split()
        if digits:
            try:
                nums.append(int(digits[0]))
            except ValueError:
                pass
    out["list_sum"] = sum(nums)
    out["card_equals_list"] = str(sum(nums)) == out["card_value"]
    shot(page, "P10-negative-stock.png")
    RESULT["P10"] = out


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": VIEW_W, "height": VIEW_H},
            device_scale_factor=2,
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
        )
        page = ctx.new_page()
        # 红线：测试不写真实账本
        ctx.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
        page.on(
            "console",
            # 断网用例（P4）会主动拔网，浏览器必然打一条断网噪音，不算缺陷
            lambda m: CONSOLE_ERRORS.append(f"console.{m.type}: {m.text}")
            if m.type == "error"
            and not any(
                s in m.text for s in ("ERR_INTERNET_DISCONNECTED", "Failed to fetch", "net::ERR")
            )
            else None,
        )
        page.on("pageerror", lambda e: CONSOLE_ERRORS.append(f"pageerror: {e}"))

        page.goto(BASE, wait_until="networkidle")
        page.get_by_role("button", name="记一笔").last.wait_for(timeout=25000)
        page.wait_for_timeout(400)

        for name, fn in [
            ("P1", p1_rapid_taps),
            ("P2_purchase", p2_purchase_qty),
            ("P2_stock", p2_stock_adjust),
            ("P3", p3_picker_title),
            ("P4", p4_offline),
            ("P6", p6_negative_cost),
            ("P8", p8_add_button),
            ("P10", p10_negative_stock),
        ]:
            print(f"[{name}]")
            try:
                fn(page)
            except Exception as exc:  # noqa: BLE001 - 单个用例失败不影响其它用例
                RESULT[name] = {"error": f"{exc.__class__.__name__}: {exc}"}
                traceback.print_exc()
                try:
                    page.screenshot(path=os.path.join(OUT, f"FAIL-{name}.png"))
                except Exception:  # noqa: BLE001
                    pass

        browser.close()

    print("\n=== RESULT ===")
    print(json.dumps(RESULT, ensure_ascii=False, indent=2))
    if CONSOLE_ERRORS:
        print("\n!! console 错误：")
        for e in CONSOLE_ERRORS:
            print("  ", e)
        return 1
    print("\nconsole 错误：0")
    return 0


if __name__ == "__main__":
    sys.exit(main())