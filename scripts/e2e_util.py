"""E2E 公共工具。

`wait_for_toast` 用来替换「固定 sleep 后读当前 toast」的写法：旧写法会读到上一条
尚未被替换的 toast（例如刚记完一单的「已记 1 单」），在 CI 慢机器上更容易复现。
只等待目标文案，断言本身仍由调用方负责。
"""

from __future__ import annotations

from playwright.sync_api import Page
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

TOAST_SELECTOR = ".toast"


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
