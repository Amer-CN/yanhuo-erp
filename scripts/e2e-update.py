"""PWA 更新入口的真实 Chromium 回归（仅 loopback，绝不写真实账本）。

先由集成者 build，或显式提供私有 build：
    python scripts/e2e-update.py --dist <已构建目录>

脚本将 dist 复制到系统临时目录，自带独占 127.0.0.1:4184 fixture server。
仅 fixture 的 sw.js 响应切换版本，使用真实 ServiceWorker 生命周期和 Workbox
SKIP_WAITING 消息；不改生产 SW，也不在页面暴露测试 API。每场景新 context，
默认禁同步并拦所有 REST。证据默认输出系统临时目录（UPDATE_OUT 可指定）。
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Lock, Thread
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent


class Fixture:
    def __init__(self, directory: Path, host: str, port: int):
        self.directory = directory
        self.version = 1
        self.fail_sw = False
        self.hold_sw = False
        self.release_sw = Event()
        self.lock = Lock()
        self.requests: list[dict] = []
        fixture = self

        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(directory), **kwargs)

            def log_message(self, *_args):
                pass

            def do_GET(self):
                if urlparse(self.path).path == "/sw.js":
                    with fixture.lock:
                        version = fixture.version
                        fail = fixture.fail_sw
                        hold = fixture.hold_sw
                        fixture.requests.append({"version": version, "fail": fail})
                    if hold:
                        fixture.release_sw.wait(timeout=15)
                    if fail:
                        self.send_error(503, "Fixture update unavailable")
                        return
                    script = f"""// Actual browser service worker fixture, version {version}.
self.addEventListener('install', () => {{}});
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {{
  if (event.data && event.data.type === 'SKIP_WAITING') {{
    event.waitUntil((async () => {{
      await fetch('/fixture-skip-waiting?version={version}');
      await self.skipWaiting();
    }})());
  }}
}});
""".encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/javascript; charset=utf-8")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", str(len(script)))
                    self.end_headers()
                    self.wfile.write(script)
                    return
                if urlparse(self.path).path == "/fixture-skip-waiting":
                    with fixture.lock:
                        fixture.requests.append({"skipWaiting": self.path})
                    self.send_response(204)
                    self.end_headers()
                    return
                super().do_GET()

            def end_headers(self):
                self.send_header("Cache-Control", "no-store")
                super().end_headers()

        self.server = ThreadingHTTPServer((host, port), Handler)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        address, selected_port = self.server.server_address[:2]
        self.url = f"http://{address}:{selected_port}/"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.release_sw.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def reset(self):
        with self.lock:
            self.version = 1
            self.fail_sw = False
            self.hold_sw = False
            self.requests.clear()
            self.release_sw.clear()


def new_context(browser, *, no_sw=False, width=390, theme="light"):
    context = browser.new_context(
        viewport={"width": width, "height": 844},
        locale="zh-CN",
        timezone_id="Asia/Shanghai",
        color_scheme=theme,
        reduced_motion="reduce",
        service_workers="block" if no_sw else "allow",
    )
    context.add_init_script("localStorage.setItem('yh-sync-disabled', '1')")
    context.route("**/rest/v1/**", lambda route: route.abort())
    if no_sw:
        # Exercise the real unsupported-browser branch, not a simulated update result.
        context.add_init_script("delete Navigator.prototype.serviceWorker")
    return context


def open_settings(page, url):
    page.goto(url, wait_until="networkidle")
    page.get_by_role("button", name="更多", exact=True).click()
    page.get_by_role("button", name="设置与同步").click()
    expect(page.get_by_role("heading", name="本机与操作人")).to_be_visible()


def update_section(page):
    return page.locator("section").filter(has=page.get_by_role("heading", name="应用更新", exact=True))


def sw_ready(page):
    page.wait_for_function("""async () => {
      const r = await navigator.serviceWorker.getRegistration();
      return Boolean(r && r.active && navigator.serviceWorker.controller);
    }""", timeout=15000)


def make_pending(page, fixture):
    sw_ready(page)
    with fixture.lock:
        fixture.version = 2
    # Trigger the real browser update algorithm; UI must consume its waiting event.
    page.evaluate("async () => (await navigator.serviceWorker.getRegistration()).update()")
    page.wait_for_function("""async () =>
      Boolean((await navigator.serviceWorker.getRegistration()).waiting)
    """, timeout=15000)
    expect(page.get_by_role("button", name="稍后", exact=True)).to_be_visible(timeout=15000)


def pending_later(browser, fixture, out):
    fixture.reset()
    context = new_context(browser)
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    navigations: list[str] = []
    page.on("framenavigated", lambda frame: navigations.append(frame.url) if frame == page.main_frame else None)
    try:
        page.goto(fixture.url, wait_until="networkidle")
        make_pending(page, fixture)
        before_later = len(navigations)
        page.get_by_role("button", name="稍后", exact=True).click()
        expect(page.get_by_role("button", name="稍后", exact=True)).to_have_count(0)
        page.get_by_role("button", name="更多", exact=True).click()
        page.get_by_role("button", name="设置与同步").click()
        # This assertion is the old-version RED: later used to remove the only entry.
        expect(page.get_by_role("heading", name="应用更新", exact=True)).to_be_visible(timeout=4000)
        section = update_section(page)
        expect(section).to_contain_text("有新版本待更新")
        expect(section).to_contain_text("当前构建：")
        expect(section.get_by_role("button", name="更新并重新打开", exact=True)).to_be_enabled()
        assert len(navigations) == before_later, "稍后/打开设置不应自动刷新"
        assert page.evaluate("async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting)")
        assert not any("skipWaiting" in item for item in fixture.requests), "只有主动更新才应发 SKIP_WAITING"
        page.screenshot(path=str(out / "pending-after-later.png"))
        with page.expect_navigation(wait_until="networkidle", timeout=15000):
            section.get_by_role("button", name="更新并重新打开", exact=True).click()
        sw_ready(page)
        assert page.evaluate("async () => !(await navigator.serviceWorker.getRegistration()).waiting")
        assert sum("skipWaiting" in item for item in fixture.requests) == 1, fixture.requests
        assert len(navigations) == before_later + 1, "更新应仅重载一次"
        assert not errors, errors
        return {"scenario": "pending/later/settings-update", "result": "PASS", "reloads": 1, "requests": list(fixture.requests)}
    finally:
        page.screenshot(path=str(out / "pending-final.png"))
        context.close()


def existing_controller(browser, fixture, out):
    """第二种真实生命周期：新页面注册时已经有旧 worker controller。"""
    fixture.reset()
    context = new_context(browser)
    first = context.new_page()
    page = None
    navigations: list[str] = []
    errors: list[str] = []
    try:
        first.goto(fixture.url, wait_until="networkidle")
        sw_ready(first)
        first.close()
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("framenavigated", lambda frame: navigations.append(frame.url) if frame == page.main_frame else None)
        page.goto(fixture.url, wait_until="networkidle")
        sw_ready(page)
        assert page.evaluate("async () => Boolean((await navigator.serviceWorker.getRegistration()).active)")
        make_pending(page, fixture)
        page.get_by_role("button", name="稍后", exact=True).click()
        page.get_by_role("button", name="更多", exact=True).click()
        page.get_by_role("button", name="设置与同步").click()
        section = update_section(page)
        expect(section.get_by_role("button", name="更新并重新打开", exact=True)).to_be_enabled()
        before_update = len(navigations)
        with page.expect_navigation(wait_until="networkidle", timeout=15000):
            section.get_by_role("button", name="更新并重新打开", exact=True).click()
        sw_ready(page)
        assert page.evaluate("async () => !(await navigator.serviceWorker.getRegistration()).waiting")
        assert sum("skipWaiting" in item for item in fixture.requests) == 1, fixture.requests
        assert len(navigations) == before_update + 1, navigations
        assert not errors, errors
        page.screenshot(path=str(out / "pending-existing-controller.png"))
        return {
            "scenario": "pending/existing-controller/settings-update",
            "result": "PASS",
            "reloads": len(navigations),
            "requests": list(fixture.requests),
        }
    finally:
        if page is not None:
            page.close()
        context.close()


def check_failure(browser, fixture, out):
    fixture.reset()
    context = new_context(browser)
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        open_settings(page, fixture.url)
        sw_ready(page)
        section = update_section(page)
        check = section.get_by_role("button", name="检查更新", exact=True)
        expect(check).to_be_enabled()
        with fixture.lock:
            fixture.fail_sw = True
            fixture.hold_sw = True
        check.click()
        expect(section.get_by_role("button", name="检查中…", exact=True)).to_be_disabled()
        fixture.release_sw.set()
        expect(section.get_by_role("alert")).to_contain_text("检查更新失败", timeout=10000)
        expect(section).not_to_contain_text("已是最新版本")
        expect(section.get_by_role("button", name="检查更新", exact=True)).to_be_enabled()
        assert any(item.get("fail") for item in fixture.requests), fixture.requests
        assert not errors, errors
        page.screenshot(path=str(out / "check-failure.png"))
        # Recover with a successful real update check, still with no automatic reload.
        with fixture.lock:
            fixture.fail_sw = False
            fixture.hold_sw = False
        check.click()
        expect(section).to_contain_text("检查完成", timeout=10000)
        expect(section.get_by_role("alert")).to_have_count(0)
        return {"scenario": "checking/failure/retry", "result": "PASS", "requests": list(fixture.requests)}
    finally:
        fixture.release_sw.set()
        context.close()


def no_service_worker(browser, fixture, out):
    fixture.reset()
    context = new_context(browser, no_sw=True)
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        open_settings(page, fixture.url)
        section = update_section(page)
        expect(page.get_by_role("heading", name="应用更新", exact=True)).to_be_visible()
        expect(section).to_contain_text("当前环境不支持应用更新")
        expect(section).to_contain_text("当前构建：")
        expect(section.get_by_role("button", name="检查更新", exact=True)).to_be_disabled()
        assert not errors, errors
        assert not fixture.requests, fixture.requests
        page.screenshot(path=str(out / "no-service-worker.png"))
        return {"scenario": "no-service-worker", "result": "PASS", "pageErrors": errors}
    finally:
        context.close()


def visual_matrix(browser, fixture, out):
    results = []
    for width in (320, 390, 768):
        for theme in ("light", "dark"):
            context = new_context(browser, no_sw=True, width=width, theme=theme)
            context.add_init_script(f"localStorage.setItem('yh-theme', '{theme}')")
            try:
                page = context.new_page()
                open_settings(page, fixture.url)
                section = update_section(page)
                section.scroll_into_view_if_needed()
                expect(section).to_be_visible()
                metrics = section.evaluate("""node => {
                  const r = node.getBoundingClientRect();
                  return {left: r.left, right: r.right, viewport: innerWidth,
                    scrollWidth: node.scrollWidth, clientWidth: node.clientWidth};
                }""")
                assert metrics["left"] >= 0 and metrics["right"] <= width + 1, metrics
                assert metrics["scrollWidth"] <= metrics["clientWidth"], metrics
                page.screenshot(path=str(out / f"update-{width}-{theme}.png"))
                results.append({"width": width, "theme": theme, "metrics": metrics})
            finally:
                context.close()
    return {"scenario": "visual-widths-themes-reduced-motion", "result": "PASS", "cases": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4184)
    parser.add_argument(
        "--case", choices=("all", "pending", "existing", "failure", "no-sw", "visual"), default="all"
    )
    args = parser.parse_args()
    if args.host not in {"127.0.0.1", "localhost"}:
        raise SystemExit("更新回归只允许 loopback")
    source = args.dist.resolve()
    if not (source / "index.html").is_file() or not (source / "sw.js").is_file():
        raise SystemExit(f"需要现有生产构建（不由此脚本build）：{source}")
    out = Path(os.environ.get("UPDATE_OUT") or tempfile.mkdtemp(prefix="yh-update-evidence-"))
    out.mkdir(parents=True, exist_ok=True)
    report = {"dist": str(source), "out": str(out), "cases": [], "hardware": "Chromium loopback fixture; physical installed PWA untested"}
    print(f"evidence: {out}")
    try:
        with tempfile.TemporaryDirectory(prefix="yh-update-fixture-") as temporary:
            directory = Path(temporary) / "app"
            shutil.copytree(source, directory)
            with Fixture(directory, args.host, args.port) as fixture, sync_playwright() as playwright:
                print(f"fixture: {fixture.url}")
                browser = playwright.chromium.launch()
                try:
                    cases = {
                        "pending": pending_later,
                        "existing": existing_controller,
                        "failure": check_failure,
                        "no-sw": no_service_worker,
                        "visual": visual_matrix,
                    }
                    selected = cases.items() if args.case == "all" else [(args.case, cases[args.case])]
                    for name, run in selected:
                        print(f"[{name}] running")
                        result = run(browser, fixture, out)
                        report["cases"].append(result)
                        print(f"[{name}] PASS")
                finally:
                    browser.close()
        report["result"] = "PASS"
        return 0
    except Exception as error:
        report["result"] = "FAIL"
        report["error"] = str(error)
        print(f"FAIL: {error}")
        return 1
    finally:
        (out / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
