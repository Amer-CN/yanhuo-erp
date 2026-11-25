"""两台设备自动云同步端到端验证（v2 场次记账；默认使用本地假 Supabase）。

用法（先 pnpm dev）：
    python scripts/e2e-sync.py

断言面使用「更多 → 销售记录」：它按本机收到的全部订单聚合，不受场次归属设备限制。

此脚本是全仓唯一不设 `yh-sync-disabled=1` 的脚本，因为它要验证真实同步：
- 默认（不设 SYNC_*）运行本地 v2 协议假 Supabase，不访问云端；
- 真实模式必须显式配置 SYNC_URL / SYNC_KEY / SYNC_LEDGER 和 SYNC_TEST_ONLY=1。
  配置账本只作为测试 namespace，每次运行派生独立 ledger，收尾使用 operationId 清空 RPC；
  内置账本仍由启动护栏拒绝。
"""

import json
import os
import subprocess
import sys
import tempfile
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

from playwright.sync_api import sync_playwright

from e2e_sync_guard import UnsafeSyncConfiguration, validate_sync_run_config
from e2e_sync_cleanup import clear_run, load_or_create_run, remove_run_if_matches, run_file_lock, run_with_cleanup
from e2e_util import wait_for_save_receipt

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE = os.environ.get("SYNC_TEST_BASE", "http://127.0.0.1:5173/")
PORT = 54321
MOCK = os.path.join(ROOT, "scripts", "mock-supabase.mjs")
OUT = os.path.join(ROOT, "docs", "screenshots", "e2e")
os.makedirs(OUT, exist_ok=True)

# 三项全部未设置才允许假后端；真实模式必须显式声明“测试专用账本”，且护栏不可失效。
SYNC_DEFAULTS = os.path.join(ROOT, "src", "db", "syncDefaults.ts")

def load_builtin_source() -> str | None:
    try:
        with open(SYNC_DEFAULTS, encoding="utf-8") as source_file:
            return source_file.read()
    except OSError:
        return None

try:
    RUN_CONFIG = validate_sync_run_config(os.environ, load_builtin_source())
except UnsafeSyncConfiguration as exc:
    raise SystemExit(f"E2E 配置被安全护栏拒绝：{exc}") from exc

USE_MOCK = RUN_CONFIG.use_mock
REAL_URL = RUN_CONFIG.url
REAL_KEY = RUN_CONFIG.key
RUN_FILE = os.environ.get("SYNC_TEST_RUN_FILE") or os.path.join(tempfile.gettempdir(), "yanhuo-e2e-sync-run.json")
REAL_RUN = None

errors: list[str] = []


def config():
    if USE_MOCK:
        return (f"http://127.0.0.1:{PORT}", "test-anon-key", "test-ledger-2026")
    if REAL_RUN is None:
        raise RuntimeError("真实 E2E 运行身份尚未初始化")
    return (REAL_URL, REAL_KEY, REAL_RUN["ledger"])


def init_script():
    url, key, ledger = config()
    values = json.dumps({"yh-sync-url": url, "yh-sync-anon": key, "yh-sync-ledger": ledger})
    return f"Object.entries({values}).forEach(([key,value]) => localStorage.setItem(key,value));"


def cleanup_cloud():
    """清理当前运行专属的真实测试账本；失败时保留运行文件供同号续办。"""
    if USE_MOCK:
        return
    if REAL_RUN is None:
        raise RuntimeError("真实 E2E 运行身份尚未初始化")
    payload = clear_run(RUN_FILE, REAL_RUN, REAL_URL, REAL_KEY)
    print("[cleanup] 当前 E2E 运行账本已确认清空：", payload["operationId"])
    remove_run_if_matches(RUN_FILE, REAL_RUN)


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
    # 2026-11-12（P3）：连续开单的回执改到底栏内联（.record-receipt），
    # 不再是浮层 Toast（Toast 会压住自动弹开的选商品层标题）；文案仍是「已记 1 单」。
    if wait_for_save_receipt(page, "已记") is None:
        raise AssertionError("保存后底栏没有出现「已记」回执")
    # 自动重开的选商品层 600ms 后才弹（P1），等它真的出现再关
    page.wait_for_selector(".glass-sheet", timeout=5000)
    page.wait_for_timeout(500)
    # 「保存并记下一单」会顺带重开选商品弹层（连续开单设计，RecordEditor.tsx
    # 里 setPickOpen(true)），弹层遮罩会挡住开单页的「返回」，先关掉再返回。
    # 用「存在且可见才点」而不是固定等待，避免以后 UI 再变就误报超时。
    finish = page.get_by_role("button", name="完成（回单据）")
    if finish.count() > 0 and finish.first.is_visible():
        finish.first.click()
        page.wait_for_timeout(300)
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
    if USE_MOCK:
        return main_unlocked()
    with run_file_lock(RUN_FILE):
        return main_unlocked()


def main_unlocked() -> int:
    global REAL_RUN
    # 配置已在模块入口 fail closed，启动浏览器/假后端之前完成验证。
    mock = None
    if USE_MOCK:
        mock = subprocess.Popen(
            ["node", MOCK, str(PORT)],
            cwd=ROOT,
            env={**os.environ, "MOCK_SCHEMA_MODE": "v2"},
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        time.sleep(1.0)
        if mock.poll() is not None:
            print("mock server failed:", mock.stdout.read() if mock.stdout else "")
            return 1
    else:
        if os.path.exists(RUN_FILE):
            previous = load_or_create_run(RUN_FILE, RUN_CONFIG.ledger, REAL_URL)
            print("[sync] 先确认上一轮测试账本清理：", previous["ledger"])
            clear_run(RUN_FILE, previous, REAL_URL, REAL_KEY)
            remove_run_if_matches(RUN_FILE, previous)
        REAL_RUN = load_or_create_run(RUN_FILE, RUN_CONFIG.ledger, REAL_URL)
        print("[sync] 使用真实 Supabase：", REAL_URL)
        print("[sync] 本轮测试账本：", REAL_RUN["ledger"])
        print("[sync] 运行记录文件：", RUN_FILE)

    def stop_mock():
        if mock is None:
            return
        mock.terminate()
        try:
            mock.wait(timeout=5)
        except subprocess.TimeoutExpired:
            mock.kill()

    def browser_test():
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

    def cleanup_all():
        run_with_cleanup(cleanup_cloud, stop_mock)

    run_with_cleanup(browser_test, cleanup_all)

    if errors:
        print("\n!! 问题：")
        for e in errors:
            print("   ", e)
        return 1
    print("\nOK：两台设备自动同步，无需手动导出/导入")
    return 0


if __name__ == "__main__":
    sys.exit(main())