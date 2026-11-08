"""无障碍回归（v2 场次记账）：标签关联、弹层焦点、Esc、键盘行、触控尺寸、减动效。

用法：
  pnpm dev   # 或 pnpm build && pnpm preview -- --port 4173
  python scripts/a11y-check.py [base_url]
"""

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
        ctx.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
        page = ctx.new_page()
        for i in range(40):
            try:
                page.goto(BASE, wait_until="networkidle", timeout=8000)
                break
            except Exception:
                if i == 39:
                    raise
                time.sleep(0.5)
        page.get_by_role("button", name="记一笔").first.wait_for(timeout=20000)

        print("[1] 标签关联")
        page.get_by_role("button", name="记一笔").last.click()
        page.get_by_role("button", name="添加商品").first.click()
        page.wait_for_selector(".glass-search input", timeout=5000)
        search = page.locator(".glass-search input")
        check("选商品搜索框有可访问名", bool(search.get_attribute("aria-label")), "aria-label 缺失")

        page.get_by_role("button", name="大地红 1000 响", exact=False).first.click()
        page.get_by_role("button", name="完成（回单据）").click()
        page.wait_for_selector(".record-line", timeout=5000)
        labels = page.evaluate(
            """() => Array.from(document.querySelectorAll('.record-page .glass-input-group')).map(g => {
                const f = g.querySelector('input,select,textarea');
                const l = g.querySelector('label');
                return { label: l ? l.textContent.trim() : '', forId: l ? l.getAttribute('for') : null, id: f ? f.id : null };
            })"""
        )
        bad_labels = [x for x in labels if not x["id"] or x["forId"] != x["id"]]
        check("单据字段 label for=控件 id", len(bad_labels) == 0, f"{len(bad_labels)} 个未关联: {bad_labels[:3]}")

        print("[2] 弹层焦点与 Esc")
        trigger = page.get_by_role("button", name="添加商品").first
        trigger.click()
        page.wait_for_selector(".glass-sheet[role=dialog]", timeout=5000)
        dialog = page.locator(".glass-sheet[role=dialog]")
        check("弹层有 aria-labelledby", bool(dialog.get_attribute("aria-labelledby")), "缺失")
        check(
            "焦点在弹层内",
            page.evaluate("() => !!document.activeElement.closest('.glass-sheet')"),
            page.evaluate("() => document.activeElement.className"),
        )
        page.keyboard.press("Escape")
        page.wait_for_timeout(650)
        check("Esc 关闭弹层", page.locator(".glass-sheet[role=dialog]").count() == 0)
        check(
            "关闭后焦点归还触发按钮",
            page.evaluate("() => (document.activeElement.textContent || '').includes('添加商品')"),
            page.evaluate("() => (document.activeElement.textContent || document.activeElement.className || '').slice(0, 30)"),
        )

        print("[3] 键盘操作列表行")
        page.get_by_role("button", name="返回").click()
        page.wait_for_timeout(400)
        if page.get_by_text("这单还没保存", exact=False).count() > 0:
            page.get_by_role("button", name="离开").click()
            page.wait_for_timeout(500)
        page.get_by_role("button", name="更多").click()
        page.wait_for_selector(".list-item", timeout=5000)
        row = page.locator(".list-item").first
        row.focus()
        page.keyboard.press("Enter")
        page.wait_for_timeout(500)
        check("更多列表行 Enter 可进入", page.locator(".back-btn").count() > 0, "未进入子页")
        page.locator(".back-btn").click()
        page.wait_for_timeout(400)
        page.get_by_role("button", name="记账").click()
        page.wait_for_timeout(300)

        print("[4] 触控目标")
        small = page.evaluate(
            """() => Array.from(document.querySelectorAll("button, a, [role=button], select, input:not([type=checkbox]):not([type=radio]):not([type=hidden])"))
                .filter(e => {
                    const r = e.getBoundingClientRect();
                    const s = getComputedStyle(e);
                    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && (r.width < 44 || r.height < 44);
                })
                .map(e => (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 24) + ` ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`)"""
        )
        check("记账首页无小于 44 的可见控件", len(small) == 0, f"{len(small)} 个: {small[:5]}")

        print("[5] 减动效")
        motion = page.evaluate(
            """() => {
                const bad = [];
                for (const el of document.querySelectorAll('.prod-btn, .glass-btn, .glass-tab-bar__item, .record-actions, .sample-note')) {
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