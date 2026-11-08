"""无障碍回归：标签关联、弹层焦点、Esc、键盘行、触控尺寸、减动效。
用法（先 pnpm dev）：python scripts/a11y-check.py [base_url]
"""

import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173/"

problems: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("  ✓ " if ok else "  ✗ ") + name + (f" — {detail}" if detail else ""))
    if not ok:
        problems.append(f"{name}: {detail}")


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=2,
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
            reduced_motion="reduce",
        )
        page = ctx.new_page()
        for i in range(40):
            try:
                page.goto(BASE, wait_until="networkidle", timeout=8000)
                break
            except Exception:
                if i == 39:
                    raise
                time.sleep(0.5)
        page.wait_for_selector("text=大地红 1000 响", timeout=20000)

        print("[1] 表单标签关联")
        search = page.locator(".glass-search input")
        check("搜索框有可访问名", bool(search.get_attribute("aria-label")), "aria-label 缺失")
        page.get_by_role("button", name="进货").click()
        page.wait_for_selector(".glass-input-group", timeout=5000)
        labels = page.evaluate(
            """() => Array.from(document.querySelectorAll('.glass-input-group')).map(g => {
                const f = g.querySelector('input,select,textarea');
                const l = g.querySelector('label');
                return { label: l ? l.textContent.trim() : '', forId: l ? l.getAttribute('for') : null, id: f ? f.id : null };
            })"""
        )
        bad_labels = [x for x in labels if not x["id"] or x["forId"] != x["id"]]
        check("进货字段 label for=控件 id", len(bad_labels) == 0, f"{len(bad_labels)} 个未关联: {bad_labels[:3]}")

        print("[2] 弹层焦点与 Esc")
        page.get_by_role("button", name="开单").click()
        page.locator(".prod-btn").first.click()
        page.wait_for_selector(".checkout-bar", timeout=5000)
        page.locator(".checkout-dock__count").click()
        page.wait_for_selector(".glass-sheet[role=dialog]", timeout=5000)
        dialog = page.locator(".glass-sheet[role=dialog]")
        check("弹层有 aria-labelledby", bool(dialog.get_attribute("aria-labelledby")), dialog.get_attribute("aria-labelledby") or "")
        check(
            "焦点在弹层内",
            page.evaluate("() => !!document.activeElement.closest('.glass-sheet')"),
            page.evaluate("() => document.activeElement.className"),
        )
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)
        check("Esc 关闭弹层", page.locator(".glass-sheet[role=dialog]").count() == 0)
        check(
            "关闭后焦点归还",
            page.evaluate("() => document.activeElement.className.includes('checkout-dock__count')"),
            page.evaluate("() => document.activeElement.className"),
        )

        print("[3] 键盘操作列表行")
        page.get_by_role("button", name="更多").click()
        page.wait_for_selector(".list-item", timeout=5000)
        row = page.locator(".list-item").first
        row.focus()
        page.keyboard.press("Enter")
        page.wait_for_timeout(500)
        check("更多列表行 Enter 可进入", page.locator(".back-btn").count() > 0, "未进入子页")
        page.locator(".back-btn").click()
        page.wait_for_timeout(400)

        print("[4] 触控目标")
        page.get_by_role("button", name="开单").click()
        page.wait_for_timeout(600)
        small = page.evaluate(
            """() => Array.from(document.querySelectorAll('button, a, [role=button], input, select'))
                .filter(e => {
                    const r = e.getBoundingClientRect();
                    const s = getComputedStyle(e);
                    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && (r.width < 44 || r.height < 44);
                })
                .map(e => (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 24) + ` ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`)"""
        )
        check("开单页无小于 44 的可见控件", len(small) == 0, f"{len(small)} 个: {small[:5]}")

        print("[5] 减动效")
        motion = page.evaluate(
            """() => {
                const bad = [];
                for (const el of document.querySelectorAll('.prod-btn, .checkout-dock, .glass-tab-bar__item, .glass-btn')) {
                    const s = getComputedStyle(el);
                    if (parseFloat(s.transitionDuration) > 0.05 || parseFloat(s.animationDuration) > 0.05) {
                        bad.push(el.className.split(' ')[0] + ' t=' + s.transitionDuration + ' a=' + s.animationDuration);
                    }
                }
                return bad;
            }"""
        )
        check("reduce 下无残留长动画", len(motion) == 0, f"{len(motion)} 个: {motion[:4]}")

        browser.close()

    print()
    if problems:
        print("!! 未通过：")
        for x in problems:
            print("   -", x)
        return 1
    print("OK：无障碍回归全通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())