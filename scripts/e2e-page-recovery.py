"""Lazy page failure must expose a working explicit reload (loopback only)."""

import os
import sys
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
BASE = os.environ.get("PAGE_RECOVERY_BASE", "http://127.0.0.1:4173/")


def main():
    if urlsplit(BASE).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("Page recovery regression requires loopback")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = None
        requests = []
        fail = {"report": True}

        def chunk(route):
            url = route.request.url
            if "/rest/v1/" in url:
                route.abort()
            elif "/ReportPage" in url or "/assets/ReportPage-" in url:
                requests.append(url)
                if fail["report"]:
                    route.abort()
                else:
                    route.continue_()
            else:
                route.continue_()

        try:
            context = browser.new_context(viewport={"width": 390, "height": 844}, locale="zh-CN", service_workers="block")
            context.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
            context.route("**/*", chunk)
            page = context.new_page()
            page.goto(BASE, wait_until="networkidle")
            page.get_by_role("button", name="记一笔", exact=True).last.click()
            page.get_by_role("button", name="添加商品", exact=True).first.click()
            page.get_by_role("button", name="大地红 1000 响", exact=False).first.click()
            page.get_by_role("button", name="完成（回单据）", exact=True).click()
            note = page.get_by_label("备注", exact=False)
            note.fill("page-recovery-draft")
            page.get_by_role("button", name="返回", exact=True).click()
            page.get_by_role("button", name="离开", exact=True).click()
            page.get_by_role("button", name="报表", exact=True).click()
            expect(page.get_by_text("这一页没打开", exact=True)).to_be_visible()
            fail["report"] = False
            reload_button = page.get_by_role("button", name="重新打开应用", exact=True)
            expect(reload_button).to_be_visible()
            reload_button.click()
            page.wait_for_load_state("networkidle")
            page.get_by_role("button", name="报表", exact=True).click()
            expect(page.get_by_text("这一页没打开", exact=True)).to_have_count(0)
            expect(page.get_by_text("今天", exact=False).first).to_be_visible()
            assert len(requests) >= 2, "reload never re-requested the failed page chunk"
            page.get_by_role("button", name="记账", exact=True).click()
            page.get_by_role("button", name="记一笔", exact=True).last.click()
            expect(page.get_by_label("备注", exact=False)).to_have_value("page-recovery-draft")
            print("OK: explicit reload recovers failed lazy chunk; unsaved draft is preserved")
        finally:
            try:
                if context is not None:
                    context.close()
            finally:
                browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
