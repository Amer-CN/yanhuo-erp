"""Sync setup help regression: rendered SQL matches the canonical script.

Only a loopback preview is permitted. REST requests are intercepted in fresh
browser contexts; no test data is sent to an actual Supabase project.
"""

import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("STABILITY_BASE", "http://127.0.0.1:4173/")


def main():
    if urlsplit(BASE).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("Sync help regression requires a loopback preview")
    canonical = (ROOT / "supabase" / "schema.sql").read_bytes().decode("utf-8")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for enabled in (False, True):
                context = browser.new_context(viewport={"width": 390, "height": 844}, locale="zh-CN")
                context.add_init_script("""{
                    localStorage.setItem('yh-sync-url', 'https://sync.test.invalid');
                    localStorage.setItem('yh-sync-anon', 'test-only');
                    localStorage.setItem('yh-sync-ledger', 'test-only-ledger');
                    Object.defineProperty(navigator, 'clipboard', {value: {
                        writeText: async text => { window.__copiedSql = text; }
                    }});
                }""")
                if not enabled:
                    context.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
                context.route("**/rest/v1/**", lambda route: route.fulfill(
                    status=200, content_type="application/json", body="[]"))
                page = context.new_page()
                try:
                    page.goto(BASE, wait_until="networkidle")
                    page.get_by_role("button", name="更多", exact=True).click()
                    page.locator(".list-item", has_text="设置与同步").click()
                    if enabled:
                        page.get_by_role("button", name="修改配置", exact=True).click()
                    page.get_by_role("button", name="怎么配置？看步骤", exact=True).click()
                    dialog = page.get_by_role("dialog")
                    expect(dialog).to_be_visible()
                    rendered = dialog.locator(".sql-block").text_content()
                    assert rendered == canonical, "Setup help SQL differs from supabase/schema.sql"
                    statements = re.sub(r"--[^\n]*", "", re.sub(r"/\*[\s\S]*?\*/", "", rendered))
                    assert not re.search(r"grant[^;]*\bdelete\b", statements, re.I), "Help grants physical DELETE"
                    assert not re.search(r"using\s*\(\s*true\s*\)", statements, re.I), "Help opens unrestricted RLS"
                    help_text = dialog.inner_text()
                    assert "with check (true)" not in help_text, "Help advises removing ledger isolation"
                    dialog.get_by_role("button", name="复制 SQL", exact=True).click()
                    page.wait_for_function("window.__copiedSql !== undefined")
                    assert page.evaluate("window.__copiedSql") == canonical
                    print(f"OK: enabled={enabled}, displayed and copied SQL are canonical; RLS remains scoped")
                finally:
                    context.close()
        finally:
            browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
