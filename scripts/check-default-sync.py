"""验证零配置：不写任何 localStorage，应用应自动用内置配置发出同步请求。
请求被拦截，不写真实数据库。用法：python scripts/check-default-sync.py
"""

import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:5173/")
EXPECT_HOST = "lnmjmnzddncxvwkvdhoo.supabase.co"
EXPECT_LEDGER = "beddbf7e285340e3bda1e6319ddaf3ce2dc9d0d652eb42ff"

seen = []

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, locale="zh-CN")
    page = ctx.new_page()

    def handler(route):
        req = route.request
        seen.append((req.url, req.headers.get("x-ledger-key", "")))
        route.abort()

    page.route("**/rest/v1/**", handler)
    page.goto(BASE, wait_until="networkidle")
    page.wait_for_selector("text=大地红 1000 响", timeout=20000)
    page.wait_for_timeout(4000)

    print("拦截到同步请求：", len(seen))
    for url, ledger in seen[:6]:
        print(" ", url[:90], "| ledger:", ledger[:16] + "...")

    ok = any(EXPECT_HOST in u and ledger == EXPECT_LEDGER for u, ledger in seen)
    browser.close()

print("OK：零配置自动使用内置同步" if ok else "FAIL：没有用内置配置发请求")
sys.exit(0 if ok else 1)