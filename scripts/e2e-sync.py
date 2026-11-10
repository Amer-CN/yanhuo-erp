"""两台设备自动云同步端到端验证（v2 场次记账，不需要真的 Supabase）。

用法（先 pnpm dev）：
    python scripts/e2e-sync.py

断言面使用「更多 → 销售记录」：它按本机收到的全部订单聚合，不受场次归属设备限制。
"""

import os
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

from playwright.sync_api import sync_playwright

from e2e_util import wait_for_toast

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE = os.environ.get("SYNC_TEST_BASE", "http://127.0.0.1:5173/")
PORT = 54321
MOCK = os.path.join(ROOT, "scripts", "mock-supabase.mjs")
OUT = os.path.join(ROOT, "docs", "screenshots", "e2e")
os.makedirs(OUT, exist_ok=True)

# 不设 SYNC_URL 就用本地假 Supabase；设了就跑真实项目（跑完清理测试账本）
REAL_URL = os.environ.get("SYNC_URL")
REAL_KEY = os.environ.get("SYNC_KEY")
REAL_LEDGER = os.environ.get("SYNC_LEDGER")
USE_MOCK = not (REAL_URL and REAL_KEY and REAL_LEDGER)

errors: list[str] = []


def config():
    if USE_MOCK:
        return (f"http://127.0.0.1:{PORT}", "test-anon-key", "test-ledger-2026")
    return (REAL_URL, REAL_KEY, REAL_LEDGER)


def init_script():
    url, key, ledger = config()
    return f"""
      localStorage.setItem('yh-sync-url', '{url}');
      localStorage.setItem('yh-sync-anon', '{key}');
      localStorage.setItem('yh-sync-ledger', '{ledger}');
    """


def cleanup_cloud():
    """清理真实测试账本。

    v2 策略撤销了 anon 的 DELETE，这里只能做软删除（deleted=true）。
    行会保留在表里；要物理清需要 service_role 在控制台操作。
    """
    if USE_MOCK:
        return
    import json
    import time
    import urllib.parse
    import urllib.request

    target = f"{REAL_URL}/rest/v1/yh_records?ledger=eq." + urllib.parse.quote(REAL_LEDGER)
    body = json.dumps({"deleted": True, "updated_at": int(time.time() * 1000)}).encode()
    req = urllib.request.Request(
        target,
        data=body,
        method="PATCH",
        headers={
            "apikey": REAL_KEY,
            "x-ledger-key": REAL_LEDGER,
            "Prefer": "return=minimal",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            print("[cleanup] 云端测试账本已软删除", r.status)
    except Exception as e:  # noqa: BLE001
        print("[cleanup] 清理失败：", e)


def new_page(browser, tag):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=2,
        locale="zh-CN",
        timezone_id="Asia/Shanghai",
    )
    ctx.add_init_script(init_script())
    page = ctx.new_page()

    def on_console(m):
        if m.type != "error":
            return
        # 断网补发用例会主动断网，轮询失败的浏览器噪音不算缺陷
        if any(s in m.text for s in ("ERR_INTERNET_DISCONNECTED", "Failed to fetch", "net::ERR")):
            return
        errors.append(f"[{tag}] console.{m.type}: {m.text}")

    page.on("console", on_console)
    page.on("pageerror", lambda e: errors.append(f"[{tag}] pageerror: {e}"))
    for i in range(40):
        try:
            page.goto(BASE, wait_until="networkidle", timeout=8000)
            break
        except Exception:
            if i == 39:
                raise
            time.sleep(0.5)
    page.get_by_role("button", name="记一笔").last.wait_for(timeout=20000)
    return ctx, page


def sell(page, product: str) -> None:
    """v2：记一笔 → 选商品 → 保存并记下一单 → 返回首页。"""
    page.get_by_role("button", name="记一笔").last.click()
    page.get_by_role("button", name="添加商品").first.wait_for(timeout=5000)
    page.get_by_role("button", name="添加商品").first.click()
    page.get_by_role("button", name=product, exact=False).first.click()
    page.get_by_role("button", name="完成（回单据）").click()
    page.get_by_role("button", name="保存并记下一单").click()
    if wait_for_toast(page, "已记", timeout=8000) is None:
        raise AssertionError("保存后没有出现「已记」提示")
    page.wait_for_timeout(400)
    page.get_by_role("button", name="返回").click()
    page.wait_for_timeout(500)


def open_history(page) -> None:
    page.get_by_role("button", name="更多").click()
    page.locator(".list-item", has_text="销售记录").click()
    # 页面加载即可；数据可能还没同步到，交给 wait_history 轮询
    page.locator(".back-btn").wait_for(timeout=8000)


def history_total(page) -> str:
    loc = page.locator(".day-header .sub").first
    return loc.inner_text() if loc.count() else "0 单 · 合计 ¥0.00"


def back_home(page) -> None:
    page.get_by_role("button", name="返回").click()
    page.wait_for_timeout(300)
    page.get_by_role("button", name="记账").click()
    page.wait_for_timeout(400)


def wait_history(page, want: str, timeout: int = 35) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if want in history_total(page):
            return True
        page.wait_for_timeout(1000)
    return False


def main() -> int:
    mock = None
    if USE_MOCK:
        mock = subprocess.Popen(
            ["node", MOCK, str(PORT)],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        time.sleep(1.0)
        if mock.poll() is not None:
            print("mock server failed:", mock.stdout.read() if mock.stdout else "")
            return 1
    else:
        print("[sync] 使用真实 Supabase：", REAL_URL)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx_a, a = new_page(browser, "A")
            ctx_b, b = new_page(browser, "B")
            print("[1] 两台设备已带同一个同步码启动")

            print("[2] A 记一单 ¥25.00，等 B 自动看到")
            sell(a, "大地红 1000 响")
            open_history(b)
            seen = wait_history(b, "1 单 · 合计 ¥25.00")
            print("    B 销售记录：", history_total(b), "->", "OK" if seen else "TIMEOUT")
            if not seen:
                errors.append("B 没有自动拉到 A 的销售")
            b.screenshot(path=os.path.join(OUT, "20-同步-B看到A的单.png"))
            back_home(b)

            print("[3] B 记一单 ¥1.50，等 A 自动看到两单 ¥26.50")
            sell(b, "二踢脚")
            open_history(a)
            seen2 = wait_history(a, "2 单 · 合计 ¥26.50")
            print("    A 销售记录：", history_total(a), "->", "OK" if seen2 else "TIMEOUT")
            if not seen2:
                errors.append("A 没有自动拉到 B 的销售")
            a.screenshot(path=os.path.join(OUT, "21-同步-A看到两单.png"))

            print("[4] B 断网记一单 ¥15.00，恢复网络后 A 自动收到三单 ¥41.50")
            ctx_b.set_offline(True)
            sell(b, "加特林")
            open_history(b)
            local_seen = wait_history(b, "3 单 · 合计 ¥41.50", timeout=8)
            print("    B 本地销售记录：", history_total(b), "->", "OK" if local_seen else "TIMEOUT")
            if not local_seen:
                errors.append("B 离线时本地没有记上这一单")
            print("    断网期间 A 销售记录：", history_total(a))
            ctx_b.set_offline(False)
            seen3 = wait_history(a, "3 单 · 合计 ¥41.50", timeout=45)
            print("    恢复网络后 A 销售记录：", history_total(a), "->", "OK" if seen3 else "TIMEOUT")
            if not seen3:
                errors.append("B 恢复网络后 A 没有自动收到补发的单")
            a.screenshot(path=os.path.join(OUT, "22-同步-离线补发.png"))

            ctx_a.close()
            ctx_b.close()
            browser.close()
    finally:
        cleanup_cloud()
        if mock is not None:
            mock.terminate()
            try:
                mock.wait(timeout=5)
            except subprocess.TimeoutExpired:
                mock.kill()

    if errors:
        print("\n!! 问题：")
        for e in errors:
            print("   ", e)
        return 1
    print("\nOK：两台设备自动同步，无需手动导出/导入")
    return 0


if __name__ == "__main__":
    sys.exit(main())