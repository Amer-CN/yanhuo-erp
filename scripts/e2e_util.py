"""E2E 公共工具。

`wait_for_toast` 用来替换「固定 sleep 后读当前 toast」的写法：旧写法会读到上一条
尚未被替换的 toast（例如刚记完一单的「已记 1 单」），在 CI 慢机器上更容易复现。
只等待目标文案，断言本身仍由调用方负责。

`wait_for_save_receipt` 是「保存并记下一单」的新落点（2026-11-12 起）：
连续开单的回执不再做成浮层 Toast（Toast 置顶 72–150 会压住自动弹开的选商品层
标题「选商品 / 本单已加 N 种」），而是开单页底栏里内联的一行 `.record-receipt`。
断言口径不变：文案里必须含「已记 1 单」。
"""

from __future__ import annotations

from playwright.sync_api import Page
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

TOAST_SELECTOR = ".toast"
RECEIPT_SELECTOR = ".record-receipt"


def wait_for_toast(page: Page, text: str, timeout: int = 5000) -> str | None:
    """等待包含 text 的 toast 出现并返回其文本；超时返回 None。"""
    loc = page.locator(TOAST_SELECTOR).filter(has_text=text).first
    try:
        loc.wait_for(timeout=timeout)
    except PlaywrightTimeoutError:
        return None
    try:
        return loc.inner_text()
    except Exception:  # noqa: BLE001 - toast 可能在读取瞬间消失，但已确认出现过
        return text


def wait_for_save_receipt(page: Page, text: str = "已记", timeout: int = 8000) -> str | None:
    """等待开单页底栏的内联保存回执出现并返回其文本；超时返回 None。

    用途与 wait_for_toast 相同，只是选择器换成了底栏那一条（见模块 docstring）。
    """
    loc = page.locator(RECEIPT_SELECTOR).filter(has_text=text).first
    try:
        loc.wait_for(timeout=timeout)
    except PlaywrightTimeoutError:
        return None
    try:
        return loc.inner_text()
    except Exception:  # noqa: BLE001 - 回执 6 秒后会淡出，读不到也算「出现过」
        return text
