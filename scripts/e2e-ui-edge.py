"""F05 UI 回归：库存草稿隔离、提交边界、历史原生详情/撤销按钮。

先启动自己的 loopback dev（不写共享 dist）：
    pnpm exec vite --host 127.0.0.1 --port 4182 --strictPort
    python scripts/e2e-ui-edge.py --base http://127.0.0.1:4182/

每个 case 独立 browser context，初始化关闭同步，REST/外网全部 abort。
业务数据经 UI 建立；IndexedDB readonly 读取核对结果。busy 用原生 IDB 事务
暂时阻塞 adjustments 写入，failure 仅一次注入本 context 的存储写失败。
每次运行新建 tempdir 保存 JSON/截图，context/browser 关闭即清理测试账本。
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import sys
import tempfile
import traceback
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import Browser, Page, expect, sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

A = "大地红 1000 响"
B = "二踢脚"
READ_LEDGER = """async () => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('yanhuo-erp');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
  try {
    const names = ['orders', 'lines', 'adjustments', 'products'];
    const tx = db.transaction(names, 'readonly');
    return Object.fromEntries(await Promise.all(names.map(name => new Promise((resolve, reject) => {
      const req = tx.objectStore(name).getAll();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve([name, req.result]);
    }))));
  } finally { db.close(); }
}"""

# 仅观察本 context 的 2200ms 数量提示计时器，验证 cancel 清理，不控制 React state。
OBSERVE_HINT_TIMERS = """(() => {
  const timers = new Set();
  const start = window.setTimeout.bind(window);
  const clear = window.clearTimeout.bind(window);
  window.__f05HintTimers = timers;
  window.__f05ClearedHints = 0;
  window.setTimeout = (handler, delay, ...args) => {
    let id;
    id = start((...values) => { timers.delete(id); handler(...values); }, delay, ...args);
    if (delay === 2200) timers.add(id);
    return id;
  };
  window.clearTimeout = id => {
    if (timers.delete(id)) window.__f05ClearedHints += 1;
    clear(id);
  };
})();"""


def assert_local_base(base: str) -> None:
    parsed = urlsplit(base)
    try:
        local = parsed.hostname == "localhost" or ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        local = False
    if parsed.scheme not in {"http", "https"} or not local or parsed.username or parsed.password:
        raise ValueError(f"仅允许 loopback dev/preview：{base}")


def ledger(page: Page) -> dict:
    return page.evaluate(READ_LEDGER)


def evidence(page: Page, out: Path, name: str, extra: dict | None = None) -> dict:
    state = ledger(page)
    (out / f"{name}.json").write_text(json.dumps({"ledger": state, **(extra or {})}, ensure_ascii=False, indent=2), encoding="utf-8")
    page.screenshot(path=str(out / f"{name}.png"), full_page=True)
    return state


def stock(page: Page) -> None:
    page.get_by_role("button", name="库存", exact=True).click()
    expect(page.get_by_text("库存总件数", exact=True)).to_be_visible()
    notice = page.locator(".toast").get_by_role("button", name="知道了", exact=True)
    if notice.count():
        notice.click()


def open_stock(page: Page, name: str) -> None:
    page.locator(".stock-page li").filter(has_text=name).click()
    expect(page.get_by_role("dialog", name=name, exact=True)).to_be_visible()


def draft(page: Page) -> dict:
    dialog = page.get_by_role("dialog")
    return {
        "product": dialog.get_by_role("heading").first.inner_text(),
        "quantity": dialog.get_by_label("调整数量", exact=False).input_value(),
        "reason": dialog.get_by_label("原因（可空）", exact=True).input_value(),
        "loss": dialog.get_by_role("button", name="少了（盘亏 / 摔坏）", exact=True).get_attribute("aria-pressed"),
        "more": dialog.get_by_role("button", name="多了（盘盈）", exact=True).get_attribute("aria-pressed"),
    }


def fill_adjustment(page: Page, quantity: str, reason: str, more: bool = False) -> None:
    dialog = page.get_by_role("dialog")
    dialog.get_by_role("button", name="多了（盘盈）" if more else "少了（盘亏 / 摔坏）", exact=True).click()
    dialog.get_by_label("调整数量", exact=False).fill(quantity)
    dialog.get_by_label("原因（可空）", exact=True).fill(reason)


def close_stock(page: Page, method: str = "close") -> None:
    if method == "escape":
        page.keyboard.press("Escape")
    elif method == "backdrop":
        page.locator(".glass-sheet-overlay").click(position={"x": 5, "y": 5})
    elif method == "back":
        page.evaluate("() => history.back()")
    else:
        page.get_by_role("dialog").get_by_role("button", name="关闭", exact=True).click()
    expect(page.get_by_role("dialog")).to_have_count(0)


def case_stock_cancel(page: Page, out: Path, method: str) -> None:
    stock(page)
    open_stock(page, A)
    fill_adjustment(page, "5", "X-取消草稿", more=True)
    close_stock(page, method)
    # 缺货列表也必须经过同一 openAdjustment 入口。
    page.get_by_role("button", name=re.compile(r"缺货 .*点击只看缺货")).click()
    open_stock(page, B)
    actual = draft(page)
    evidence(page, out, f"stock-{method}-B-before-submit", {"draft": actual})
    page.get_by_role("button", name="记一笔调整", exact=True).click()
    expect(page.locator(".toast")).to_be_visible()
    state = evidence(page, out, f"stock-{method}-B-after-submit", {"draft_before_submit": actual})
    assert actual["quantity"] == "" and actual["reason"] == "" and actual["loss"] == "true", f"A 取消后的草稿串到 B：{actual}；DB adjustments={state['adjustments']}"
    assert state["adjustments"] == [], f"空草稿提交写了旧商品/错商品调整：{state['adjustments']}"
    fill_adjustment(page, "2", "B-本商品")
    page.get_by_role("button", name="记一笔调整", exact=True).click()
    expect(page.get_by_role("dialog")).to_have_count(0)
    state = evidence(page, out, f"stock-{method}-B-saved")
    assert len(state["adjustments"]) == 1, state
    adjustment = state["adjustments"][0]
    assert adjustment["productId"] == "sample-2" and adjustment["qtyBase"] == -2 and adjustment["reason"] == "B-本商品", state
    open_stock(page, B)
    assert draft(page)["quantity"] == "" and draft(page)["reason"] == "" and draft(page)["loss"] == "true"


def case_stock_hint(page: Page, out: Path) -> None:
    stock(page)
    open_stock(page, A)
    page.get_by_label("调整数量", exact=False).fill("1.5")
    expect(page.get_by_role("dialog")).to_contain_text("整数")
    assert page.evaluate("() => window.__f05HintTimers.size") == 1
    close_stock(page)
    open_stock(page, B)
    timers = page.evaluate("() => window.__f05HintTimers.size")
    text = page.get_by_role("dialog").inner_text()
    cleared = page.evaluate("() => window.__f05ClearedHints")
    evidence(page, out, "stock-hint-cleared", {"active_hint_timers": timers, "explicitly_cleared": cleared, "dialog_text": text})
    assert cleared >= 1, "旧商品 hint timer 自然到期掩盖了漏清理，未观察到 clearTimeout"
    assert timers == 0, f"关闭后仍有旧商品的 hint timer：{timers}"
    assert "填正数就行，方向上面已经选了" in text, text


def case_stock_failure(page: Page, out: Path) -> None:
    stock(page)
    open_stock(page, A)
    fill_adjustment(page, "5", "X-重试草稿", more=True)
    page.evaluate("""() => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'adjustments') {
          IDBObjectStore.prototype.put = original;
          throw new DOMException('F05 local write failure', 'QuotaExceededError');
        }
        return original.apply(this, args);
      };
    }""")
    page.get_by_role("button", name="记一笔调整", exact=True).click()
    expect(page.locator(".toast")).to_contain_text("没记上")
    actual = draft(page)
    state = evidence(page, out, "stock-failure-retains-draft", {"draft": actual})
    assert actual == {"product": A, "quantity": "5", "reason": "X-重试草稿", "loss": "false", "more": "true"}, actual
    assert state["adjustments"] == [], state
    page.get_by_role("button", name="记一笔调整", exact=True).click()
    expect(page.get_by_role("dialog")).to_have_count(0)
    state = evidence(page, out, "stock-failure-retry-saved")
    assert len(state["adjustments"]) == 1, state
    adjustment = state["adjustments"][0]
    assert adjustment["productId"] == "sample-1" and adjustment["qtyBase"] == 5 and adjustment["reason"] == "X-重试草稿", state
    open_stock(page, A)
    assert draft(page)["quantity"] == "" and draft(page)["reason"] == "" and draft(page)["loss"] == "true"


def hold_adjustments(page: Page) -> None:
    page.evaluate("""async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('yanhuo-erp');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
      });
      const tx = db.transaction('adjustments', 'readwrite');
      let hold = true;
      window.__f05ReleaseAdjustment = () => { hold = false; };
      window.__f05AdjustmentReleased = false;
      tx.oncomplete = () => { db.close(); window.__f05AdjustmentReleased = true; };
      await new Promise(resolve => {
        let started = false;
        const tick = () => {
          const req = tx.objectStore('adjustments').get('__f05_hold__');
          req.onsuccess = () => {
            if (!started) { started = true; resolve(); }
            if (hold) tick();
          };
        };
        tick();
      });
    }""")


def case_stock_busy(page: Page, out: Path) -> None:
    stock(page)
    open_stock(page, A)
    fill_adjustment(page, "5", "X-唯一提交", more=True)
    hold_adjustments(page)
    try:
        # 同一个 JS task，React 还没把 saving 传回 DOM；ref 必须挡住第二次提交。
        page.get_by_role("button", name="记一笔调整", exact=True).evaluate("button => { button.click(); button.click(); }")
        expect(page.get_by_role("button", name="记一笔调整", exact=True)).to_be_disabled()
        dialog = page.get_by_role("dialog")
        controls = dialog.locator("input, button").evaluate_all("els => els.map(e => ({name: e.getAttribute('aria-label') || e.textContent.trim() || e.placeholder, disabled: e.disabled}))")
        page.keyboard.press("Escape")
        dialog.get_by_role("button", name="关闭", exact=True).evaluate("button => button.click()")
        page.evaluate("() => history.back()")
        page.locator(".glass-sheet-overlay").click(position={"x": 5, "y": 5})
        # 只触发实际背景列表的 DOM click，不调用 React 内部函数；保存中必须拒绝换目标。
        page.locator(".stock-page li").filter(has_text=B).evaluate("row => row.click()")
        title = page.get_by_role("dialog").get_by_role("heading").first.inner_text()
        page.screenshot(path=str(out / "stock-busy-locked.png"), full_page=True)
        (out / "stock-busy-controls.json").write_text(json.dumps({"controls": controls, "title_after_dismiss_and_switch": title}, ensure_ascii=False, indent=2), encoding="utf-8")
    finally:
        page.evaluate("() => window.__f05ReleaseAdjustment?.()")
    page.wait_for_function("() => window.__f05AdjustmentReleased")
    expect(page.get_by_role("dialog")).to_have_count(0)
    state = evidence(page, out, "stock-busy-result")
    assert all(control["disabled"] for control in controls), f"保存时还有可变字段/关闭入口：{controls}"
    assert title == A, f"保存中切换成了 {title}"
    assert len(state["adjustments"]) == 1, f"同轮重复提交写了多笔：{state['adjustments']}"
    assert state["adjustments"][0]["productId"] == "sample-1" and state["adjustments"][0]["qtyBase"] == 5, state


def create_order(page: Page) -> str:
    page.get_by_role("button", name="记一笔", exact=True).last.click()
    page.get_by_role("button", name="添加商品", exact=True).first.click()
    for name in [A, B]:
        page.get_by_role("button", name=name, exact=False).first.click()
    page.get_by_role("button", name="完成（回单据）", exact=True).click()
    page.get_by_role("button", name="只保存", exact=True).click()
    expect(page.get_by_role("button", name="记一笔", exact=True).last).to_be_visible()
    state = ledger(page)
    assert len(state["orders"]) == 1 and state["orders"][0]["totalFen"] == 2650 and len(state["lines"]) == 2, state
    page.get_by_role("button", name="更多", exact=True).click()
    page.locator(".list-item").filter(has_text="销售记录").click()
    expect(page.get_by_role("heading", name="销售记录", exact=True)).to_be_visible()
    return state["orders"][0]["id"]


def void_order(page: Page) -> None:
    row = page.locator("li.list-item").first
    # 旧 li 与新独立 button 都走真实 UI，RED 可保留同一业务前置条件。
    details = row.locator("button").first
    (details if details.count() else row).click()
    page.get_by_role("button", name="删除这笔", exact=True).click()
    page.get_by_role("dialog").last.get_by_role("button", name="删除这笔", exact=True).click()
    expect(page.get_by_role("dialog")).to_have_count(0)
    assert ledger(page)["orders"][0].get("voided") is True


def case_history_structure(page: Page, out: Path) -> None:
    create_order(page)
    void_order(page)
    structure = page.locator("li.list-item").first.evaluate("""li => ({
      role: li.getAttribute('role'), tabIndex: li.getAttribute('tabindex'),
      buttons: [...li.querySelectorAll('button')].map(b => ({
        text: b.innerText, label: b.getAttribute('aria-label'), parent: b.parentElement.tagName,
        rect: {width: b.getBoundingClientRect().width, height: b.getBoundingClientRect().height}
      })),
      nestedInteractive: li.matches('[role=button],button,a[href]') || !!li.querySelector('button button,[role=button] button,button [role=button]')
    })""")
    evidence(page, out, "history-role-structure", {"structure": structure, "aria_snapshot": page.locator("main").aria_snapshot()})
    assert structure["role"] is None and structure["tabIndex"] is None and not structure["nestedInteractive"], f"历史 li 仍是包住撤销按钮的交互容器：{structure}"
    assert len(structure["buttons"]) == 2 and all(button["parent"] == "LI" for button in structure["buttons"]), structure
    details, undo = structure["buttons"]
    assert "¥26.50" in details["text"] and "2 个商品" in details["text"], structure
    assert re.search(r"\d{2}:\d{2}", details["label"] or "") and "26.50" in details["label"], structure
    assert "撤销删除" in undo["label"], structure
    assert all(button["rect"]["width"] >= 44 and button["rect"]["height"] >= 44 for button in structure["buttons"]), structure


def case_history_keyboard(page: Page, out: Path, activation: str = "Enter") -> None:
    order_id = create_order(page)
    void_order(page)
    row = page.locator("li.list-item").first
    details = row.get_by_role("button", name=re.compile("详情"))
    undo = row.get_by_role("button", name=re.compile("撤销删除"))
    details.focus()
    page.keyboard.press("Tab")
    expect(undo).to_be_focused()
    page.keyboard.press("Shift+Tab")
    expect(details).to_be_focused()
    tab_order = [details.get_attribute("aria-label"), undo.get_attribute("aria-label")]
    for key in ["Enter", "Space"]:
        details.focus()
        page.keyboard.press(key)
        expect(page.get_by_role("dialog")).to_have_count(1)
        expect(page.get_by_role("dialog")).to_contain_text("¥26.50")
        expect(page.locator(".glass-sheet-overlay")).to_have_class(re.compile("is-active"))
        page.keyboard.press("Escape")
        expect(page.get_by_role("dialog")).to_have_count(0)
    # MutationObserver 保留瞬时 sheet 打开证据，不能靠 restore 最终关闭蒙混通过。
    page.evaluate("""() => {
      window.__f05OpenedSheets = [];
      window.__f05SheetObserver = new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node.nodeType === 1 && (node.matches('.glass-sheet') || node.querySelector('.glass-sheet'))) window.__f05OpenedSheets.push(node.textContent.slice(0, 120));
        }
      });
      window.__f05SheetObserver.observe(document.body, {childList: true, subtree: true});
    }""")
    undo.focus()
    if activation == "click":
        undo.click()
    else:
        page.keyboard.press(activation)
    expect(row).not_to_have_class(re.compile("is-voided"))
    expect(page.get_by_role("dialog")).to_have_count(0)
    expect(page.locator(".day-header")).to_contain_text("1 单 · 合计 ¥26.50")
    opened = page.evaluate("() => { window.__f05SheetObserver.disconnect(); return window.__f05OpenedSheets; }")
    state = evidence(page, out, f"history-{activation}-restored", {"tab_order": tab_order, "undo_activation": activation, "opened_sheets_during_undo": opened})
    assert opened == [], f"撤销同时打开过详情：{opened}"
    assert len(state["orders"]) == 1 and state["orders"][0]["id"] == order_id and not state["orders"][0].get("voided"), state
    assert state["orders"][0]["totalFen"] == 2650 and sum(line["amountFen"] for line in state["lines"]) == 2650, state


def case_history_layout(page: Page, out: Path) -> None:
    create_order(page)
    for deleted in [False, True]:
        if deleted:
            void_order(page)
        for width in [390, 320]:
            page.set_viewport_size({"width": width, "height": 844})
            row = page.locator("li.history-item")
            expect(row).to_have_count(1)
            expect(row).to_be_visible()
            expected_buttons = 2 if deleted else 1
            expect(row.locator("button")).to_have_count(expected_buttons)
            layout = row.evaluate("""li => ({
              viewport: innerWidth, document: document.documentElement.scrollWidth,
              row: {width: li.getBoundingClientRect().width, height: li.getBoundingClientRect().height, scroll: li.scrollWidth, client: li.clientWidth},
              buttons: [...li.querySelectorAll('button')].map(b => ({width: b.getBoundingClientRect().width, height: b.getBoundingClientRect().height, right: b.getBoundingClientRect().right}))
            })""")
            evidence(page, out, f"history-{'deleted' if deleted else 'active'}-{width}", {"layout": layout})
            assert layout["row"]["width"] > 0 and layout["row"]["height"] > 0, f"历史行必须已显示：{layout}"
            assert len(layout["buttons"]) == expected_buttons, f"历史按钮数量错误：{layout}"
            assert layout["document"] <= width and layout["row"]["scroll"] <= layout["row"]["client"], f"{width}px 横向溢出：{layout}"
            assert all(button["width"] >= 44 and button["height"] >= 44 and button["right"] <= width for button in layout["buttons"]), layout


CASES = {
    **{f"stock-cancel-{method}": (lambda page, out, method=method: case_stock_cancel(page, out, method)) for method in ["close", "escape", "backdrop", "back"]},
    "stock-hint-reset": case_stock_hint,
    "stock-failure-retry": case_stock_failure,
    "stock-busy-submit": case_stock_busy,
    "history-role-structure": case_history_structure,
    "history-keyboard-undo": case_history_keyboard,
    "history-space-undo": lambda page, out: case_history_keyboard(page, out, "Space"),
    "history-click-undo": lambda page, out: case_history_keyboard(page, out, "click"),
    "history-responsive": case_history_layout,
}


def run_case(browser: Browser, base: str, name: str, out: Path) -> dict:
    context = browser.new_context(viewport={"width": 390, "height": 844}, locale="zh-CN", timezone_id="Asia/Shanghai", reduced_motion="reduce", service_workers="block")
    context.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
    context.add_init_script(OBSERVE_HINT_TIMERS)
    origin = urlsplit(base)
    external_requests = []
    runtime_errors = []

    def route_request(route):
        parsed = urlsplit(route.request.url)
        if "/rest/v1" in parsed.path or (parsed.scheme in {"http", "https"} and (parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc)):
            external_requests.append({"method": route.request.method, "url": route.request.url})
            route.abort()
        else:
            route.continue_()

    context.route("**/*", route_request)
    page = context.new_page()
    page.set_default_timeout(8000)
    page.on("pageerror", lambda error: runtime_errors.append(str(error)))
    result = {"case": name, "status": "FAIL"}
    try:
        page.goto(base, wait_until="domcontentloaded")
        expect(page.get_by_role("button", name="记一笔", exact=True).last).to_be_visible(timeout=25000)
        CASES[name](page, out)
        assert not external_requests, f"已关闭同步却尝试 REST/外网（均已拦截）：{external_requests}"
        assert not runtime_errors, f"浏览器运行错误：{runtime_errors}"
        result["status"] = "PASS"
    except Exception as error:
        result["error"] = str(error)
        result["traceback"] = traceback.format_exc()
        try:
            page.evaluate("() => window.__f05ReleaseAdjustment?.()")
            evidence(page, out, f"FAIL-{name}")
        except Exception as capture_error:
            result["capture_error"] = str(capture_error)
    finally:
        result["external_requests_aborted"] = external_requests
        result["runtime_errors"] = runtime_errors
        context.close()
        result["context_closed"] = True
    print(f"{result['status']} {name}" + (f"：{result['error']}" if "error" in result else ""))
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:4182/")
    parser.add_argument("--case", action="append", choices=list(CASES))
    args = parser.parse_args()
    assert_local_base(args.base)
    out = Path(tempfile.mkdtemp(prefix="yh-f05-ui-edge-"))
    print(f"Evidence: {out}")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            results = [run_case(browser, args.base, name, out) for name in (args.case or CASES)]
        finally:
            browser.close()
    (out / "results.json").write_text(json.dumps({"base": args.base, "results": results, "browser_closed": True}, ensure_ascii=False, indent=2), encoding="utf-8")
    passed = sum(result["status"] == "PASS" for result in results)
    print(f"F05: {passed}/{len(results)} PASS, {len(results) - passed} FAIL, 0 SKIP；证据 {out}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
