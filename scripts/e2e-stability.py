"""F01 浏览器回归：编辑保存、建商品返回原单、草稿与意图隔离。

先启动 loopback dev/preview，例如：
    pnpm exec vite --host 127.0.0.1 --port 4181 --strictPort
    python scripts/e2e-stability.py --base http://127.0.0.1:4181/

每个 case 使用独立 context；所有业务写入都经真实 UI。原生 IndexedDB 仅用 readonly
事务断言本 context 结果。默认关闭同步，REST 和外部网络一律 abort；截图/JSON 写入
新建 tempdir。same-task 用例用原生 input + click 事件复现 effect 前的最后字符。
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import sys
import tempfile
import traceback
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import Browser, Page, expect, sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

READ_LEDGER = """async () => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('yanhuo-erp');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
  try {
    const names = ['orders', 'lines', 'sessions', 'products'];
    const tx = db.transaction(names, 'readonly');
    const rows = await Promise.all(names.map(name => new Promise((resolve, reject) => {
      const req = tx.objectStore(name).getAll();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve([name, req.result]);
    })));
    return Object.fromEntries(rows);
  } finally { db.close(); }
}"""


def assert_local_base(base: str) -> None:
    parsed = urlsplit(base)
    host = parsed.hostname or ""
    try:
        local = host == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        local = False
    if parsed.scheme not in {"http", "https"} or not local or parsed.username or parsed.password:
        raise ValueError(f"仅允许 loopback dev/preview：{base}")


def ledger(page: Page) -> dict:
    return page.evaluate(READ_LEDGER)


def evidence(page: Page, out: Path, name: str, extra: dict | None = None) -> dict:
    state = ledger(page)
    payload = {"ledger": state, **(extra or {})}
    (out / f"{name}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    page.screenshot(path=str(out / f"{name}.png"), full_page=True)
    return state


def home(page: Page) -> None:
    expect(page.get_by_role("button", name="记一笔", exact=True).last).to_be_visible(timeout=25000)


def start_new(page: Page) -> None:
    page.get_by_role("button", name="记一笔", exact=True).last.click()
    expect(page.get_by_role("heading", name="记一笔", exact=True)).to_be_visible()


def add_product(page: Page, name: str) -> None:
    page.get_by_role("button", name="添加商品", exact=True).first.click()
    page.get_by_role("button", name=name, exact=False).first.click()
    page.get_by_role("button", name="完成（回单据）", exact=True).click()
    expect(page.get_by_role("dialog")).to_have_count(0)


def save_only(page: Page) -> None:
    page.get_by_role("button", name="只保存", exact=True).click()
    home(page)


def create_x(page: Page) -> dict:
    start_new(page)
    add_product(page, "大地红 1000 响")
    save_only(page)
    state = ledger(page)
    assert len(state["orders"]) == 1, state
    assert state["orders"][0]["totalFen"] == 2500, state
    return state["orders"][0]


def edit_x(page: Page) -> None:
    page.locator(".glass-list__item").filter(has_text="大地红").first.click()
    expect(page.get_by_role("heading", name="改这一单", exact=True)).to_be_visible()


def amount(page: Page, value: str) -> None:
    page.locator('.record-line input[inputmode="decimal"]').first.fill(value)


def enter_products(page: Page, query: str = "F01-不存在的商品") -> None:
    page.get_by_role("button", name="添加商品", exact=True).first.click()
    page.get_by_role("searchbox", name="搜商品名", exact=True).fill(query)
    page.get_by_role("button", name="去建商品", exact=True).click()
    expect(page.get_by_role("heading", name="商品管理", exact=True)).to_be_visible()


def create_product(page: Page, name: str, price: str = "3.25") -> None:
    page.get_by_role("button", name="新建", exact=True).click()
    page.get_by_label("商品名", exact=True).fill(name)
    page.get_by_label("零售标价", exact=False).fill(price)
    page.get_by_role("button", name="保存", exact=True).click()
    expect(page.get_by_role("dialog")).to_have_count(0)


def close_session(page: Page) -> None:
    page.get_by_role("button", name="收摊结账", exact=True).click()
    page.get_by_role("button", name="确认收摊结账", exact=True).click()
    page.get_by_role("button", name="查看本场报表", exact=True).click()
    expect(page.get_by_role("button", name="补记", exact=True)).to_be_visible()


def case_edit_buttons(page: Page, out: Path) -> None:
    create_x(page)
    edit_x(page)
    evidence(page, out, "edit-buttons")
    expect(page.get_by_role("button", name="保存并记下一单", exact=True)).to_have_count(0)
    expect(page.get_by_role("button", name="只保存", exact=True)).to_have_count(0)
    expect(page.get_by_role("button", name="保存修改", exact=True)).to_have_count(1)


def case_edit_next_identity(page: Page, out: Path) -> None:
    original = create_x(page)
    edit_x(page)
    amount(page, "20")
    legacy_next = page.get_by_role("button", name="保存并记下一单", exact=True)
    legacy_visible = legacy_next.count() > 0
    if legacy_visible:
        # RED 版实际执行已复现的错误路径，保留连续写覆盖的账本证据。
        legacy_next.click()
        expect(page.locator(".record-receipt")).to_contain_text("已记 1 单")
        page.get_by_role("button", name="二踢脚", exact=False).first.click()
        page.get_by_role("button", name="完成（回单据）", exact=True).click()
        page.get_by_role("button", name="只保存", exact=True).click()
        home(page)
    else:
        page.get_by_role("button", name="保存修改", exact=True).click()
        home(page)
        edited = ledger(page)
        assert len(edited["orders"]) == 1 and edited["orders"][0]["id"] == original["id"], edited
        assert edited["orders"][0]["totalFen"] == 2000, edited
        start_new(page)
        add_product(page, "二踢脚")
        save_only(page)
    state = evidence(page, out, "edit-next-identity", {"original_id": original["id"], "legacy_next": legacy_visible})
    assert len(state["orders"]) == 2, f"下一单覆盖旧单，期望 count=2：{state['orders']}"
    by_id = {o["id"]: o for o in state["orders"]}
    assert by_id[original["id"]]["totalFen"] == 2000, state
    assert sorted(o["totalFen"] for o in state["orders"]) == [150, 2000], state


def case_patch_product_return(page: Page, out: Path) -> None:
    original = create_x(page)
    close_session(page)
    before = ledger(page)
    session_id = original["sessionId"]
    patched_before = before["sessions"][0]["patchedCount"]
    page.get_by_role("button", name="补记", exact=True).click()
    add_product(page, "二踢脚")
    page.get_by_placeholder("这一单有什么要记的").fill("F01-补记末字尾")
    enter_products(page)
    create_product(page, "F01-补记新商品")
    returned_title = page.locator(".record-top h1").inner_text()
    # 即使 RED 版误回 new，也继续保存，取得实际落场证据后才断言。
    page.get_by_role("button", name="只保存", exact=True).click()
    expect(page.locator(".record-page")).to_have_count(0)
    state = evidence(page, out, "patch-return", {"original_session": session_id, "returned_title": returned_title})
    assert returned_title == "补记一笔", f"补记建商品返回误变 {returned_title}；账本={state}"
    patched_order = next(o for o in state["orders"] if o["id"] != original["id"])
    assert patched_order["totalFen"] == 475, state
    assert len([line for line in state["lines"] if line["orderId"] == patched_order["id"]]) == 2, state
    assert len(state["sessions"]) == 1, state
    session = state["sessions"][0]
    assert session["id"] == session_id and session["status"] == "closed", state
    assert session["patchedCount"] == patched_before + 1, state
    assert len(state["orders"]) == 2 and all(o["sessionId"] == session_id for o in state["orders"]), state
    assert any(o.get("note") == "F01-补记末字尾" for o in state["orders"]), state


def case_product_draft(page: Page, out: Path, mode: str, same_task: bool = False) -> None:
    original = create_x(page) if mode == "edit" else None
    if mode == "edit":
        edit_x(page)
    else:
        start_new(page)
        add_product(page, "大地红 1000 响")
    amount(page, "19.87")
    page.get_by_role("button", name="支付宝", exact=True).click()
    note = f"F01-{mode}-备注末字尾"
    page.get_by_placeholder("这一单有什么要记的").fill(note if not same_task else note[:-1])
    if same_task:
        page.get_by_role("button", name="添加商品", exact=True).first.click()
        page.get_by_role("searchbox", name="搜商品名", exact=True).fill("F01-不存在")
        # 同一 JS task 里的最后输入与离开：React onChange 处理真实 DOM 事件，
        # 不等待 debounce/effect；此处没有写 IDB 或调用应用内部函数。
        page.evaluate("""value => {
          const input = document.querySelector('input[placeholder="这一单有什么要记的"]');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
          input.dispatchEvent(new Event('input', {bubbles: true}));
          [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '去建商品').click();
        }""", note)
        expect(page.get_by_role("heading", name="商品管理", exact=True)).to_be_visible()
    else:
        enter_products(page)
    drafts = page.evaluate("""() => Object.fromEntries(Object.entries(localStorage)
      .filter(([key]) => key.startsWith('yh-record-draft')).map(([key, value]) => [key, JSON.parse(value)]))""")
    key = f"yh-record-draft:edit:{original['id']}" if original else "yh-record-draft:new"
    assert key in drafts and drafts[key]["note"] == note, f"最后字符/完整草稿未立即落盘：{drafts}"
    if original:
        assert drafts[key]["orderId"] == original["id"], drafts
    create_product(page, f"F01-{mode}-返回商品")
    expected_title = "改这一单" if original else "记一笔"
    title = page.locator(".record-top h1").inner_text()
    evidence(page, out, f"{mode}-draft-return", {"expected_title": expected_title, "actual_title": title, "drafts": drafts})
    assert title == expected_title, f"建商品返回错目标：{title} != {expected_title}"
    expect(page.get_by_placeholder("这一单有什么要记的")).to_have_value(note)
    expect(page.get_by_role("button", name="支付宝", exact=True)).to_have_attribute("aria-pressed", "true")
    expect(page.locator(".record-line")).to_have_count(2)
    expect(page.locator('.record-line input[inputmode="decimal"]').first).to_have_value("19.87")
    new_line = page.locator(".record-line").filter(has_text=f"F01-{mode}-返回商品")
    expect(new_line).to_have_count(1)
    expect(new_line.locator('input[inputmode="numeric"]')).to_have_value("1")
    page.get_by_role("button", name="添加商品", exact=True).first.click()
    page.get_by_role("button", name="完成（回单据）", exact=True).click()
    expect(new_line.locator('input[inputmode="numeric"]')).to_have_value("1")
    page.get_by_role("button", name="保存修改" if original else "只保存", exact=True).click()
    home(page)
    state = evidence(page, out, f"{mode}-draft-saved")
    assert len(state["orders"]) == 1 and state["orders"][0]["totalFen"] == 2312, state
    saved = state["orders"][0]
    assert saved["note"] == note and saved["payMethod"] == "alipay", state
    if original:
        assert saved["id"] == original["id"], state
    assert len(state["lines"]) == 2 and all(l["qtyBase"] == 1 for l in state["lines"]), state


def case_unchanged_edit_draft(page: Page, out: Path) -> None:
    original = create_x(page)
    edit_x(page)
    enter_products(page)
    key = f"yh-record-draft:edit:{original['id']}"
    raw = page.evaluate("key => localStorage.getItem(key)", key)
    evidence(page, out, "unchanged-edit-draft", {"key": key, "raw_draft": raw})
    assert raw, "未改动的 edit 跳转前没有完整保存当前草稿（旧 pending 为空）"
    draft = json.loads(raw)
    assert draft["orderId"] == original["id"] and len(draft["lines"]) == 1, draft
    assert draft["lines"][0]["amountFen"] == 2500, draft


def case_patch_continue(page: Page, out: Path) -> None:
    original = create_x(page)
    close_session(page)
    page.get_by_role("button", name="补记", exact=True).click()
    add_product(page, "二踢脚")
    expect(page.get_by_role("button", name="保存并记下一单", exact=True)).to_have_count(0)
    page.get_by_role("button", name="保存并继续补记", exact=True).click()
    page.get_by_role("button", name="二踢脚", exact=False).first.click()
    page.get_by_role("button", name="完成（回单据）", exact=True).click()
    page.get_by_role("button", name="只保存", exact=True).click()
    expect(page.locator(".record-page")).to_have_count(0)
    state = evidence(page, out, "patch-continue")
    assert len(state["sessions"]) == 1 and state["sessions"][0]["status"] == "closed", state
    assert state["sessions"][0]["patchedCount"] == 2, state
    assert len(state["orders"]) == 3 and all(o["sessionId"] == original["sessionId"] for o in state["orders"]), state


def case_cancel_intent(page: Page, out: Path) -> None:
    start_new(page)
    enter_products(page)
    page.get_by_role("button", name="新建", exact=True).click()
    page.get_by_label("商品名", exact=True).fill("F01-取消商品")
    page.get_by_role("dialog").get_by_role("button", name="关闭", exact=True).click()
    expect(page.get_by_role("dialog")).to_have_count(0)
    page.get_by_role("button", name="返回", exact=True).click()
    home(page)
    page.get_by_role("button", name="库存", exact=True).click()
    page.get_by_role("button", name="更多", exact=True).click()
    page.locator(".list-item").filter(has_text="商品管理").click()
    create_product(page, "F01-普通新建商品")
    expect(page.get_by_role("heading", name="商品管理", exact=True)).to_be_visible()
    expect(page.locator(".record-page")).to_have_count(0)
    page.get_by_role("button", name="返回", exact=True).click()
    page.get_by_role("button", name="记账", exact=True).click()
    start_new(page)
    expect(page.locator(".record-line")).to_have_count(0)
    add_product(page, "F01-普通新建商品")
    save_only(page)
    state = evidence(page, out, "cancel-and-ordinary-create")
    assert len(state["orders"]) == 1, state
    assert not any(p["name"] == "F01-取消商品" for p in state["products"]), state


def case_empty_edit_return(page: Page, out: Path) -> None:
    original = create_x(page)
    edit_x(page)
    page.get_by_role("button", name="删除 大地红 1000 响", exact=True).click()
    expect(page.locator(".record-line")).to_have_count(0)
    page.get_by_role("button", name="支付宝", exact=True).click()
    enter_products(page)
    create_product(page, "F01-替换空编辑商品")
    expect(page.get_by_role("heading", name="改这一单", exact=True)).to_be_visible()
    state = evidence(page, out, "empty-edit-return")
    expect(page.locator(".record-line")).to_have_count(1)
    expect(page.locator(".record-line").filter(has_text="大地红")).to_have_count(0)
    expect(page.get_by_role("button", name="支付宝", exact=True)).to_have_attribute("aria-pressed", "true")
    expect(page.get_by_text("继续上次没记完的单？", exact=True)).to_have_count(0)
    page.get_by_role("button", name="保存修改", exact=True).click()
    home(page)
    state = evidence(page, out, "empty-edit-saved")
    assert len(state["orders"]) == 1 and state["orders"][0]["id"] == original["id"], state
    assert state["orders"][0]["totalFen"] == 325 and state["orders"][0]["payMethod"] == "alipay", state
    assert len(state["lines"]) == 1 and state["lines"][0]["productId"] != "sample-1", state


def case_empty_payment_return(page: Page, out: Path, mode: str) -> None:
    original = create_x(page) if mode == "patch" else None
    if original:
        close_session(page)
        page.get_by_role("button", name="补记", exact=True).click()
    else:
        start_new(page)
    page.get_by_role("button", name="支付宝", exact=True).click()
    expect(page.locator(".record-line")).to_have_count(0)
    expect(page.get_by_placeholder("这一单有什么要记的")).to_have_value("")
    enter_products(page)
    key = f"yh-record-draft:patch:{original['sessionId']}" if original else "yh-record-draft:new"
    assert page.evaluate("key => localStorage.getItem(key)", key) is None, "普通空稿不应制造长期恢复提示"
    create_product(page, f"F01-{mode}-仅支付返回")
    evidence(page, out, "empty-payment-return")
    expect(page.get_by_role("heading", name="补记一笔" if original else "记一笔", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="支付宝", exact=True)).to_have_attribute("aria-pressed", "true")
    expect(page.locator(".record-line")).to_have_count(1)
    expect(page.get_by_text("继续上次没记完的单？", exact=True)).to_have_count(0)
    page.get_by_role("button", name="只保存", exact=True).click()
    expect(page.locator(".record-page")).to_have_count(0)
    state = evidence(page, out, "empty-payment-saved")
    saved = next(o for o in state["orders"] if not original or o["id"] != original["id"])
    assert saved["totalFen"] == 325 and saved["payMethod"] == "alipay", state
    if original:
        assert len(state["sessions"]) == 1 and saved["sessionId"] == original["sessionId"], state
        assert state["sessions"][0]["patchedCount"] == 1, state


def case_cancel_sheet_intent(page: Page, out: Path) -> None:
    start_new(page)
    enter_products(page)
    page.get_by_role("button", name="新建", exact=True).click()
    page.get_by_label("商品名", exact=True).fill("F01-本次取消")
    page.get_by_role("dialog").get_by_role("button", name="关闭", exact=True).click()
    expect(page.get_by_role("dialog")).to_have_count(0)
    create_product(page, "F01-取消后普通建商品")
    evidence(page, out, "cancel-sheet-ordinary-create")
    expect(page.get_by_role("heading", name="商品管理", exact=True)).to_be_visible()
    expect(page.locator(".record-page")).to_have_count(0)
    state = ledger(page)
    assert len(state["orders"]) == 0 and not any(p["name"] == "F01-本次取消" for p in state["products"]), state


def case_empty_target_invalid(page: Page, out: Path) -> None:
    original = create_x(page)
    edit_x(page)
    page.get_by_role("button", name="删除 大地红 1000 响", exact=True).click()
    expect(page.locator(".record-line")).to_have_count(0)
    page.get_by_role("button", name="支付宝", exact=True).click()
    enter_products(page)
    key = f"yh-record-draft:edit:{original['id']}"
    other = page.context.new_page()
    other.goto(page.url, wait_until="domcontentloaded")
    home(other)
    close_session(other)
    other.close()
    create_product(page, "F01-空稿失效建商品")
    expect(page.locator(".record-page")).to_have_count(0)
    evidence(page, out, "empty-target-invalid-before-review")
    page.reload(wait_until="domcontentloaded")
    home(page)
    page.get_by_role("button", name="更多", exact=True).click()
    page.locator(".list-item").filter(has_text="商品管理").click()
    page.get_by_role("button", name="核对保留草稿", exact=True).click(timeout=5000)
    expect(page.get_by_role("heading", name="改这一单", exact=True)).to_be_visible()
    expect(page.locator(".record-line")).to_have_count(0)
    expect(page.get_by_role("button", name="支付宝", exact=True)).to_have_attribute("aria-pressed", "true")
    expect(page.get_by_placeholder("这一单有什么要记的")).to_have_value("")
    expect(page.get_by_role("button", name="保存修改", exact=True)).to_be_disabled()
    expect(page.locator(".record-page").get_by_role("alert")).to_contain_text("结账")
    expect(page.get_by_text("继续上次没记完的单？", exact=True)).to_have_count(0)
    page.get_by_role("button", name="返回", exact=True).click()
    expect(page.get_by_role("button", name="核对保留草稿", exact=True)).to_be_visible()
    # 恢复入口是显式核对，不再自动消费后续普通建商品。
    create_product(page, "F01-失效后普通商品")
    expect(page.get_by_role("heading", name="商品管理", exact=True)).to_be_visible()
    page.get_by_role("button", name="核对保留草稿", exact=True).click()
    expect(page.locator(".record-line")).to_have_count(0)
    expect(page.get_by_role("button", name="支付宝", exact=True)).to_have_attribute("aria-pressed", "true")
    state = evidence(page, out, "empty-target-invalid-retained")
    assert len(state["orders"]) == 1 and state["orders"][0]["id"] == original["id"], state
    assert state["orders"][0]["totalFen"] == 2500 and len(state["lines"]) == 1, state
    assert len(state["sessions"]) == 1 and state["sessions"][0]["status"] == "closed", state
    assert page.evaluate("key => localStorage.getItem(key)", key) is None, "普通空稿仍不写长期草稿"
    page.get_by_role("button", name="返回", exact=True).click()
    page.get_by_role("button", name="丢弃保留草稿", exact=True).click()
    expect(page.get_by_role("button", name="核对保留草稿", exact=True)).to_have_count(0)
    page.reload(wait_until="domcontentloaded")
    home(page)
    page.get_by_role("button", name="更多", exact=True).click()
    page.locator(".list-item").filter(has_text="商品管理").click()
    expect(page.get_by_role("button", name="核对保留草稿", exact=True)).to_have_count(0)


def case_closed_edit_target(page: Page, out: Path) -> None:
    original = create_x(page)
    edit_x(page)
    amount(page, "18.76")
    page.get_by_placeholder("这一单有什么要记的").fill("F01-目标已结账草稿尾")
    enter_products(page)
    # 同一个隔离 context 的第二个页面通过 UI 结账，使挂起的 edit 失效。
    other = page.context.new_page()
    other.goto(page.url, wait_until="domcontentloaded")
    home(other)
    close_session(other)
    other.close()
    create_product(page, "F01-目标失效商品")
    expect(page.locator(".record-page")).to_have_count(0)
    expect(page.locator(".toast")).to_contain_text("草稿已保留")
    expect(page.locator(".toast")).to_contain_text("结账")
    drafts = page.evaluate("() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.startsWith('yh-record-draft')))")
    state = evidence(page, out, "closed-edit-target", {"drafts": drafts})
    assert f"yh-record-draft:edit:{original['id']}" in drafts, drafts
    assert len(state["orders"]) == 1 and state["orders"][0]["totalFen"] == 2500, state
    assert len(state["sessions"]) == 1 and state["sessions"][0]["status"] == "closed", state


CASES = {
    "edit-buttons": case_edit_buttons,
    "edit-next-identity": case_edit_next_identity,
    "patch-product-return": case_patch_product_return,
    "edit-product-draft": lambda p, out: case_product_draft(p, out, "edit"),
    "new-product-draft": lambda p, out: case_product_draft(p, out, "new"),
    "new-last-character": lambda p, out: case_product_draft(p, out, "new", same_task=True),
    "edit-last-character": lambda p, out: case_product_draft(p, out, "edit", same_task=True),
    "unchanged-edit-draft": case_unchanged_edit_draft,
    "patch-continue": case_patch_continue,
    "cancel-intent": case_cancel_intent,
    "empty-edit-return": case_empty_edit_return,
    "empty-new-payment": lambda p, out: case_empty_payment_return(p, out, "new"),
    "empty-patch-payment": lambda p, out: case_empty_payment_return(p, out, "patch"),
    "cancel-sheet-intent": case_cancel_sheet_intent,
    "closed-edit-target": case_closed_edit_target,
    "empty-target-invalid": case_empty_target_invalid,
}


def run_case(browser: Browser, base: str, name: str, out: Path) -> dict:
    out = out / name
    out.mkdir()
    context = browser.new_context(viewport={"width": 390, "height": 844}, locale="zh-CN", timezone_id="Asia/Shanghai", service_workers="block")
    context.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
    origin = urlsplit(base)
    external_requests = []
    runtime_errors = []

    def route_request(route):
        url = route.request.url
        parsed = urlsplit(url)
        if "/rest/v1" in parsed.path or (parsed.scheme in {"http", "https"} and (parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc)):
            external_requests.append({"method": route.request.method, "url": url})
            route.abort()
        else:
            route.continue_()

    context.route("**/*", route_request)
    page = context.new_page()
    page.on("pageerror", lambda error: runtime_errors.append(str(error)))
    result = {"case": name, "status": "FAIL"}
    try:
        page.goto(base, wait_until="domcontentloaded")
        home(page)
        CASES[name](page, out)
        assert not external_requests, f"默认关闭同步却尝试 REST/外网请求（已拦截）：{external_requests}"
        assert not runtime_errors, f"浏览器运行错误：{runtime_errors}"
        result["status"] = "PASS"
    except Exception as error:
        result["error"] = str(error)
        result["traceback"] = traceback.format_exc()
        try:
            evidence(page, out, f"FAIL-{name}")
        except Exception as capture_error:
            result["capture_error"] = str(capture_error)
    finally:
        result["external_requests_aborted"] = external_requests
        result["runtime_errors"] = runtime_errors
        context.close()
    print(f"{result['status']} {name}" + (f"：{result['error']}" if "error" in result else ""), flush=True)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:4181/")
    parser.add_argument("--case", action="append", choices=list(CASES))
    args = parser.parse_args()
    assert_local_base(args.base)
    out = Path(tempfile.mkdtemp(prefix="yh-f01-stability-"))
    print(f"Evidence: {out}", flush=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            results = [run_case(browser, args.base, name, out) for name in (args.case or CASES)]
        finally:
            browser.close()
    (out / "results.json").write_text(json.dumps({"base": args.base, "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    passed = sum(result["status"] == "PASS" for result in results)
    print(f"F01: {passed}/{len(results)} PASS, {len(results) - passed} FAIL, 0 SKIP；证据 {out}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
