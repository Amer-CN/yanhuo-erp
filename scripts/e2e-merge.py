"""两设备合并验证：A 记一单后导出，B 记一单后导入合并，检查不重复、金额相加。

用法（先 pnpm build && pnpm preview --port 4173）：
    python scripts/e2e-merge.py

前置条件：本脚本需要 `pnpm build` + `pnpm preview` 起的本地服务
（默认 http://127.0.0.1:4173/）与 Playwright Chromium；CI 未覆盖
（`.github/actions/e2e/action.yml` 只跑 4 个脚本），属人工门禁。

红线：两个上下文都注入 `localStorage['yh-sync-disabled']='1'`，测试数据不写真实账本；
脚本只允许连本机 preview（`assert_local_base()` 拦非 loopback 地址）。

断言值（25.00 / 1.50 / 26.50 / 共 8 个商品）来自 `src/db/seed.ts` 的 `SAMPLE`
示例数据：大地红 1000 响 2500 分、二踢脚 150 分、共 8 个示例商品。
**改示例数据需同步改本脚本。**

记账流程（v2「记一笔」，选择器与 `scripts/e2e-smoke.py` 完全一致）：
首页「记一笔」→「添加商品」→ 点商品 →「完成（回单据）」→「保存并记下一单」
→ 等「已记 1 单 ¥xx.xx」toast →「返回」→ 断言首页营业额。

为什么金额断言不在报表页：v2 报表按**本设备场次**统计
（`src/ui/pages/ReportPage.tsx:425-428` 的 `deviceSessions`），合并进来的 A 端订单
属于 A 的场次，B 的报表里看不到；所以「金额相加」看「更多 → 销售记录」的
按天全量合计（`src/ui/pages/HistoryPage.tsx:80-87`）。
"""

import os
import re
import sys
import tempfile
import time
from urllib.parse import urlparse

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import expect, sync_playwright

from e2e_util import wait_for_toast

BASE = os.environ.get("MERGE_BASE", "http://127.0.0.1:4173/")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "docs", "screenshots", "e2e")
os.makedirs(OUT, exist_ok=True)

# 只允许本机：避免误把测试数据打进线上账本
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}

errors: list[str] = []


def assert_local_base() -> None:
    """非 loopback 直接退出：线上环境有真实账本，合并测试会把示例数据写进去。"""
    host = urlparse(BASE).hostname or ""
    if host not in LOCAL_HOSTS:
        raise SystemExit(f"本脚本只允许连本机 preview（localhost/127.0.0.1），当前：{BASE}")


def ctx_of(browser, tag: str):
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=2,
        locale="zh-CN",
        timezone_id="Asia/Shanghai",
    )
    page = ctx.new_page()
    # 红线：测试数据不写真实账本，除非确实要验证云同步，别改这一行
    ctx.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
    page.on(
        "console",
        lambda m: errors.append(f"[{tag}] console.{m.type}: {m.text}") if m.type == "error" else None,
    )
    page.on("pageerror", lambda e: errors.append(f"[{tag}] pageerror: {e}"))
    return ctx, page


def wait_app(page) -> None:
    """打开首页并等到「记一笔」可点（预览服务刚起来时先重试几次 goto）。"""
    for i in range(60):
        try:
            page.goto(BASE, wait_until="networkidle", timeout=8000)
            break
        except Exception:
            if i == 59:
                raise
            time.sleep(0.5)
    page.get_by_role("button", name="记一笔").last.wait_for(timeout=25000)


def sell_product(page, name: str, expect_total: str) -> str:
    """记一单（1 件）并回到首页，返回保存后的 toast 文案。

    动作序列与 `scripts/e2e-smoke.py` 的 [2] 段逐条对应：那个脚本 CI 在跑，
    选择器以它为准（角色 / 文案定位，不用 CSS class），不要自己猜。
    """
    # 1. 首页「记一笔」（空态与底部 dock 各有一个，取最后一个 = dock，同 smoke）
    page.get_by_role("button", name="记一笔").last.click()

    # 2. 编辑器「添加商品」→ 打开「选商品」Sheet
    add = page.get_by_role("button", name="添加商品").first
    add.wait_for(timeout=10000)
    add.click()

    # 3. 等 Sheet 的「完成（回单据）」出现（说明商品列表已渲染），再点商品加入本单
    done_pick = page.get_by_role("button", name="完成（回单据）")
    done_pick.wait_for(timeout=5000)
    page.get_by_role("button", name=name, exact=False).first.click()
    done_pick.click()

    # 4. 回单据 →「保存并记下一单」（andNext：留在编辑器，可继续开单）
    page.get_by_role("button", name="保存并记下一单").click()

    # 5. 等「已记 1 单 ¥xx.xx」toast：金额也在这里断言，避免只测到「有单」
    toast = wait_for_toast(page, "已记 1 单", timeout=10000)
    if toast is None:
        raise AssertionError(f"保存后没等到「已记 1 单」提示（{name}）")
    if expect_total not in toast:
        errors.append(f"{name} 记账金额不对：{toast}（应含 {expect_total}）")

    # 6. 「返回」首页，等营业额刷新（替代固定 sleep：等文案比等时间稳）
    page.get_by_role("button", name="返回").click()
    expect(page.get_by_text(f"¥{expect_total}", exact=True).first).to_be_visible(timeout=10000)
    return toast


def open_settings(page) -> None:
    """首页 →「更多」→「设置与同步」。"""
    page.get_by_role("button", name="更多").click()
    row = page.locator(".list-item", has_text="设置与同步")
    row.wait_for(timeout=10000)
    row.click()


def main() -> int:
    assert_local_base()
    tmpdir = tempfile.mkdtemp(prefix="yanhuo-merge-")
    backup_path = os.path.join(tmpdir, "backup.json")

    with sync_playwright() as p:
        browser = p.chromium.launch()

        # ---------------- 设备 A：记一单 → 导出备份 ----------------
        ctx_a, a = ctx_of(browser, "A")
        wait_app(a)
        print("[A] 记一单（大地红 1000 响 25.00）：", sell_product(a, "大地红 1000 响", "25.00"))

        open_settings(a)
        export_btn = a.get_by_role("button", name="导出备份")
        export_btn.wait_for(timeout=10000)
        with a.expect_download() as dl:
            export_btn.click()
        dl.value.save_as(backup_path)
        print(f"[A] 已导出备份 {os.path.getsize(backup_path)} bytes")
        if wait_for_toast(a, "备份已导出") is None:
            errors.append("A 端导出后没有出现「备份已导出」提示")
        a.screenshot(path=os.path.join(OUT, "11-A设备.png"))

        # ---------------- 设备 B：记一单 → 导入合并 ----------------
        ctx_b, b = ctx_of(browser, "B")
        wait_app(b)
        print("[B] 记一单（二踢脚 1.50）：", sell_product(b, "二踢脚", "1.50"))

        open_settings(b)
        b.get_by_role("button", name="导入并合并").wait_for(timeout=10000)
        b.set_input_files("input[type=file]", backup_path)

        merge_btn = b.get_by_role("button", name="合并这些数据")
        merge_btn.wait_for(timeout=15000)
        b.screenshot(path=os.path.join(OUT, "13-合并预览.png"))
        merge_btn.click()

        toast = wait_for_toast(b, "合并完成", timeout=15000)
        print("[B] 合并结果 toast：", toast)
        if toast is None:
            errors.append("合并后没有出现「合并完成」提示")

        # 合并结果卡：A 的那 1 单只加了一次（订单不重复）
        try:
            expect(b.get_by_text("销售 +1 单", exact=False)).to_be_visible(timeout=10000)
        except AssertionError:
            errors.append("合并结果里订单数不是 +1，A 端订单可能重复或丢失")

        # 用结果卡里的说明文案判断 Sheet 是否已关闭（比固定 sleep 稳）
        result_note = b.get_by_text("同一条记录只算一次", exact=False)
        result_note.wait_for(timeout=10000)
        b.get_by_role("button", name="完成", exact=True).click()
        expect(result_note).to_have_count(0, timeout=10000)

        # 商品没重复：回「更多」看商品数量（8 个示例商品固定 ID，合并后仍是 8）
        b.locator(".back-btn").click()
        product_row = b.locator(".list-item", has_text="商品管理")
        product_row.wait_for(timeout=10000)
        more_text = product_row.inner_text()
        print("[B] 商品管理行：", more_text.replace("\n", " / "))
        if "共 8 个商品" not in more_text:
            errors.append(f"示例商品合并后重复了：{more_text}")

        # 金额相加：A(25.00) + B(1.50) = 26.50
        # 报表页按本设备场次统计，看不到 A 的单，故看「销售记录」的全量合计
        history_row = b.locator(".list-item", has_text="销售记录")
        history_row.click()
        day_sub = b.locator(".day-header .sub").first
        day_sub.wait_for(timeout=10000)
        try:
            expect(day_sub).to_have_text(re.compile(r"\d+ 单 · 合计 ¥26\.50"), timeout=10000)
        except AssertionError:
            errors.append(f"合并后合计金额不对：{day_sub.inner_text()}（应 26.50）")
        print("[B] 合并后 销售记录合计：", day_sub.inner_text())
        b.screenshot(path=os.path.join(OUT, "12-B设备-合并后.png"))

        ctx_a.close()
        ctx_b.close()
        browser.close()

    if errors:
        print("\n!! 问题：")
        for e in errors:
            print("   ", e)
        return 1
    print("\nOK：两设备合并正确，无重复、金额相加")
    return 0


if __name__ == "__main__":
    sys.exit(main())