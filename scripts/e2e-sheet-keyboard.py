"""Keyboard regression for initial and nested Sheet focus traps (loopback only)."""

import os
import sys
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
BASE = os.environ.get("SHEET_BASE", "http://127.0.0.1:4173/")


def focus_info(page):
    return page.evaluate("""() => {
      const sheets = [...document.querySelectorAll('.glass-sheet-overlay.is-active .glass-sheet')];
      const top = sheets[sheets.length - 1];
      const active = document.activeElement;
      return {inside: !!top?.contains(active), tag: active?.tagName,
        name: (active?.getAttribute('aria-label') || active?.textContent || '').trim()};
    }""")


def main():
    if urlsplit(BASE).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("Sheet keyboard regression requires loopback")
    failures = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            context = browser.new_context(viewport={"width": 390, "height": 844}, locale="zh-CN")
            context.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
            context.route("**/rest/v1/**", lambda route: route.abort())
            page = context.new_page()
            page.goto(BASE, wait_until="networkidle")
            page.get_by_role("button", name="记一笔", exact=True).last.click()
            page.get_by_role("button", name="添加商品", exact=True).first.click()
            sheet = page.locator(".glass-sheet-overlay.is-active .glass-sheet")
            expect(sheet).to_have_count(1)
            sheet.focus()
            page.keyboard.press("Shift+Tab")
            initial = focus_info(page)
            if not initial["inside"]:
                failures.append(f"initial Shift+Tab escaped: {initial}")
            else:
                print("OK: initial Shift+Tab stays in the open sheet")
            page.keyboard.press("Escape")
            expect(page.locator(".glass-sheet")).to_have_count(0)
            context.close()

            context = browser.new_context(viewport={"width": 390, "height": 844}, locale="zh-CN")
            context.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
            context.route("**/rest/v1/**", lambda route: route.abort())
            page = context.new_page()
            page.goto(BASE, wait_until="networkidle")
            page.get_by_role("button", name="更多", exact=True).click()
            page.locator(".list-item", has_text="商品管理").click()
            page.locator(".list-item", has_text="大地红 1000 响").first.click()
            expect(page.locator(".glass-sheet")).to_have_count(1)
            page.locator(".glass-sheet").get_by_role("button", name="删除", exact=True).click()
            expect(page.locator(".glass-sheet-overlay.is-active")).to_have_count(2)
            page.locator(".glass-sheet").last.focus()
            visited = set()
            for _ in range(12):
                page.keyboard.press("Tab")
                state = focus_info(page)
                if not state["inside"]:
                    failures.append(f"nested Tab escaped: {state}")
                visited.add(state["name"])
            if not {"关闭", "删除", "取消"}.issubset(visited):
                failures.append(f"nested Tab cannot reach all actions: {sorted(visited)}")
            reverse_visited = set()
            for _ in range(12):
                page.keyboard.press("Shift+Tab")
                state = focus_info(page)
                if not state["inside"]:
                    failures.append(f"nested Shift+Tab escaped: {state}")
                reverse_visited.add(state["name"])
            if not {"关闭", "删除", "取消"}.issubset(reverse_visited):
                failures.append(f"nested Shift+Tab cannot reach all actions: {sorted(reverse_visited)}")
            page.keyboard.press("Escape")
            expect(page.locator(".glass-sheet")).to_have_count(1)
            page.keyboard.press("Escape")
            expect(page.locator(".glass-sheet")).to_have_count(0)
            context.close()
            if not failures:
                print("OK: nested Tab/Shift+Tab traverse top-level actions; Escape closes one layer")
        finally:
            browser.close()
    if failures:
        for failure in failures:
            print("FAIL:", failure)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
