"""设置页恢复/清空的浏览器回归；只访问 loopback，所有 REST 请求均 fake/abort。

先启动独立 Vite：pnpm exec vite --host 127.0.0.1 --port 4186 --strictPort
运行：python scripts/e2e-sync-recovery.py
可设 SYNC_RECOVERY_BASE（仅 loopback），或 --case undo/clear-busy/clear-failure/clear-retry。
每例使用 fresh context，启动默认 yh-sync-disabled=1；假配置在页面就绪后注入。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from urllib.parse import urlparse

from playwright.async_api import async_playwright, expect

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
BASE = os.environ.get("SYNC_RECOVERY_BASE", "http://127.0.0.1:4186/")
FAKE_URL = "http://127.0.0.1:54329"
LEDGER = "fixture-recovery-only"
CAPABILITIES = {
    "protocolVersion": 2, "conflictTarget": "ledger,id", "ledgerScoped": True,
    "clearRpcEnabled": True, "clearEpoch": 0,
    "epochHeader": "x-yh-clear-epoch", "epochHeaderRequired": False,
}
STAMP = "2026-01-01T08:00:00.000Z"


def product(identity: str, name: str) -> dict:
    return {"id": identity, "name": name, "category": "烟花", "unitBase": "个", "boxQty": 0,
            "priceList": 100, "negotiable": True, "archived": False, "sortOrder": 0,
            "createdAt": STAMP, "updatedAt": STAMP}


def data_fixture(identity: str) -> dict:
    return {
        "products": [product(f"p-{identity}", f"保留商品-{identity}")], "batches": [],
        "orders": [{"id": f"o-{identity}", "deviceId": "fixture", "operator": "001",
                    "createdAt": STAMP, "updatedAt": STAMP, "payMethod": "cash",
                    "totalFen": 100, "lineIds": [f"l-{identity}"]}],
        "lines": [{"id": f"l-{identity}", "orderId": f"o-{identity}", "productId": f"p-{identity}",
                   "qtyBase": 1, "unit": "base", "qty": 1, "listUnitPriceFen": 100,
                   "unitPriceFen": 100, "amountFen": 100, "discountFen": 0, "updatedAt": STAMP}],
        "adjustments": [], "sessions": [], "settings": [],
    }


BUSINESS = """async () => {
  const database = await new Promise((resolve,reject) => {
    const request = indexedDB.open('yanhuo-erp');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    const result = {};
    for (const name of ['products','orders','lines']) {
      result[name] = await new Promise((resolve,reject) => {
        const request = database.transaction(name,'readonly').objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result.sort((a,b) => a.id.localeCompare(b.id)));
        request.onerror = () => reject(request.error);
      });
    }
    return result;
  } finally { database.close(); }
}"""
SEED = """async data => {
  const database = await new Promise((resolve,reject) => {
    const request = indexedDB.open('yanhuo-erp');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    const names = ['products','batches','orders','lines','adjustments','sessions','outbox'];
    await new Promise((resolve,reject) => {
      const tx = database.transaction(names, 'readwrite');
      for (const name of names) {
        const store = tx.objectStore(name); store.clear();
        for (const row of data[name] || []) store.put(row);
      }
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  } finally { database.close(); }
}"""
PENDING = """async () => {
  const database = await new Promise((resolve,reject) => {
    const request = indexedDB.open('yanhuo-erp');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve,reject) => {
      const request = database.transaction('syncMeta','readonly').objectStore('syncMeta').getAll();
      request.onsuccess = () => resolve(request.result.filter(row => row.kind === 'clear'));
      request.onerror = () => reject(request.error);
    });
  } finally { database.close(); }
}"""


class FakeCloud:
    def __init__(self, mode: str = "ok"):
        self.mode = mode
        self.requests: list[dict] = []
        self.clear_started = asyncio.Event()
        self.merged_uploaded = asyncio.Event()
        self.release = asyncio.Event()
        self.clear_attempts = 0
        self.remote_rows: list[dict] = []
        self.leaked: list[str] = []

    @property
    def writes(self) -> list[dict]:
        return [r for r in self.requests if r["method"] != "GET" and
                not r["path"].endswith("/yh_sync_capabilities")]

    async def route(self, route):
        request = route.request
        parsed = urlparse(request.url)
        if "/rest/v1/" not in parsed.path:
            if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
                self.leaked.append(request.url)
                await route.abort()
            else:
                await route.continue_()
            return
        if parsed.netloc != urlparse(FAKE_URL).netloc:
            self.leaked.append(request.url)
            await route.abort()
            return
        try:
            body = request.post_data_json
        except Exception:
            body = request.post_data
        self.requests.append({"method": request.method, "path": parsed.path, "body": body})
        headers = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*"}
        if request.method == "OPTIONS":
            await route.fulfill(status=204, headers=headers)
        elif parsed.path.endswith("/yh_sync_capabilities"):
            await route.fulfill(json=CAPABILITIES, headers=headers)
        elif parsed.path.endswith("/yh_clear_ledger") or request.method == "PATCH":
            self.clear_attempts += 1
            self.clear_started.set()
            if self.mode == "slow":
                await self.release.wait()
            if self.mode == "failure" or (self.mode == "unknown-once" and self.clear_attempts == 1):
                await route.fulfill(status=503, json={"message": "fixture clear unavailable"}, headers=headers)
            elif parsed.path.endswith("/yh_clear_ledger"):
                await route.fulfill(json={"operationId": body["p_operation_id"], "clearedAt": 1780000000000,
                                          "clearedCount": 2, "clearEpoch": 1}, headers=headers)
            else:
                await route.fulfill(status=204, headers=headers)
        elif request.method == "GET":
            await route.fulfill(json=self.remote_rows, headers=headers)
        else:
            await route.fulfill(json=[], headers=headers)
            if isinstance(body, list) and any(row.get("record_id") == "o-incoming" for row in body):
                self.merged_uploaded.set()


async def fresh(browser, cloud: FakeCloud, *, paused: bool = False):
    context = await browser.new_context(viewport={"width": 390, "height": 844}, locale="zh-CN",
                                        timezone_id="Asia/Shanghai", service_workers="block")
    await context.route("**/*", cloud.route)
    await context.add_init_script("localStorage.setItem('yh-sync-disabled','1')")
    page = await context.new_page()
    await page.goto(BASE, wait_until="networkidle")
    await page.get_by_role("button", name="记一笔").last.wait_for(timeout=20000)
    await page.evaluate(SEED, data_fixture("local"))
    await page.evaluate("""cfg => {
      localStorage.setItem('yh-sync-url',cfg.url); localStorage.setItem('yh-sync-anon','fixture-key');
      localStorage.setItem('yh-sync-ledger',cfg.ledger); localStorage.removeItem('yh-sync-disabled');
    }""", {"url": FAKE_URL, "ledger": LEDGER})
    if paused:
        await page.evaluate("""async () => {
          const database = await new Promise((resolve,reject) => {
            const req = indexedDB.open('yanhuo-erp');
            req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
          });
          try { await new Promise((resolve,reject) => {
            const tx = database.transaction('syncMeta','readwrite');
            tx.objectStore('syncMeta').put({key:'state',generation:7,paused:true,reason:'restore',
              maintenance:false,fence:0,ownerId:null,expiresAt:0});
            tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
          }); } finally { database.close(); }
          localStorage.setItem('yh-sync-disabled','1');
        }""")
    await page.get_by_role("button", name="更多", exact=True).click()
    await page.locator(".list-item", has_text="设置与同步").click()
    await page.get_by_role("button", name="清空全部数据", exact=True).wait_for()
    return context, page


async def clear_steps(page):
    await page.get_by_role("button", name="清空全部数据", exact=True).click()
    await page.get_by_role("button", name="继续", exact=True).click()
    await page.get_by_role("button", name="清空本机", exact=True).click()
    await page.get_by_role("dialog", name="同时清空云端账本？", exact=True).wait_for()


async def undo(browser):
    cloud = FakeCloud()
    context, page = await fresh(browser, cloud)
    try:
        before = await page.evaluate(BUSINESS)
        backup = {"app": "yanhuo-erp", "version": 2, "deviceId": "incoming",
                  "exportedAt": STAMP, "data": data_fixture("incoming")}
        await page.set_input_files("input[type=file]", {"name": "incoming.json", "mimeType": "application/json",
                                                       "buffer": json.dumps(backup).encode()})
        await page.get_by_role("button", name="合并这些数据", exact=True).click()
        await page.get_by_role("dialog", name="合并完成", exact=True).wait_for()
        # 合并会按设计触发延迟上传；先等其网络请求和发件箱确认，观察窗口只覆盖撤销本身。
        await asyncio.wait_for(cloud.merged_uploaded.wait(), timeout=10)
        await page.wait_for_function("""async () => {
          const database = await new Promise((resolve,reject) => {
            const req = indexedDB.open('yanhuo-erp');
            req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
          });
          try { return await new Promise((resolve,reject) => {
            const req=database.transaction('outbox','readonly').objectStore('outbox').count();
            req.onsuccess=()=>resolve(req.result===0 && Number(localStorage.getItem('yh-sync-last-sync'))>0);
            req.onerror=()=>reject(req.error);
          }); } finally { database.close(); }
        }""", timeout=10000)
        start = len(cloud.requests)
        await page.get_by_role("button", name="撤销合并", exact=True).click()
        dialog = page.get_by_role("dialog", name="撤销这次合并？", exact=True)
        await dialog.get_by_role("button", name="撤销合并", exact=True).click()
        await expect(page.get_by_role("dialog", name="合并完成", exact=True)).to_have_count(0, timeout=10000)
        writes = [r for r in cloud.requests[start:] if r["method"] in {"PATCH", "POST", "DELETE"}
                  and not r["path"].endswith("/yh_sync_capabilities")]
        assert not writes, f"撤销合并发送了云写请求：{writes}"
        assert await page.evaluate(BUSINESS) == before, "撤销未还原本机商品/订单/明细"
        assert await page.evaluate("localStorage.getItem('yh-sync-disabled')") == "1", "撤销后同步未暂停"
        assert not cloud.leaked, cloud.leaked
    finally:
        await context.close()


async def undo_without_download(browser):
    cloud = FakeCloud()
    context, page = await fresh(browser, cloud)
    try:
        backup = {"app": "yanhuo-erp", "version": 2, "deviceId": "incoming", "exportedAt": STAMP,
                  "data": data_fixture("incoming")}
        await page.set_input_files("input[type=file]", {"name": "incoming.json", "mimeType": "application/json",
                                                       "buffer": json.dumps(backup).encode()})
        await page.get_by_role("checkbox").last.uncheck()
        await page.get_by_role("button", name="合并这些数据", exact=True).click()
        result = page.get_by_role("dialog", name="合并完成", exact=True)
        await result.wait_for()
        await expect(result.get_by_role("button", name="撤销合并", exact=True)).to_be_visible()
    finally:
        await context.close()


async def clear_busy(browser):
    cloud = FakeCloud("slow")
    context, page = await fresh(browser, cloud)
    try:
        await clear_steps(page)
        dialog = page.get_by_role("dialog", name="同时清空云端账本？", exact=True)
        await dialog.get_by_role("button", name="一并清空云端", exact=True).click()
        await asyncio.wait_for(cloud.clear_started.wait(), timeout=5)
        # 同一事件中重复激活；gate 必须在任何 await 前占住。
        await dialog.evaluate("el => el.querySelector('.glass-sheet__actions button').click()")
        await expect(dialog.get_by_role("button", name="关闭", exact=True)).to_be_disabled(timeout=1000)
        await expect(dialog.get_by_role("button", name="不清了（保留数据）", exact=True)).to_be_disabled()
        await dialog.get_by_role("button", name="不清了（保留数据）", exact=True).evaluate("el => el.click()")
        await page.keyboard.press("Escape")
        await page.evaluate("history.back()")
        await page.locator(".glass-sheet-overlay").last.click(position={"x": 2, "y": 2}, force=True)
        await expect(dialog).to_be_visible()
        assert cloud.clear_attempts == 1, f"慢清空重复请求：{cloud.clear_attempts}"
        assert not cloud.leaked, cloud.leaked
    finally:
        cloud.release.set()
        await page.wait_for_timeout(100)
        await context.close()


async def clear_failure(browser):
    cloud = FakeCloud("failure")
    context, page = await fresh(browser, cloud)
    try:
        before = await page.evaluate(BUSINESS)
        await clear_steps(page)
        await page.get_by_role("button", name="一并清空云端", exact=True).click()
        await page.locator(".toast").filter(has_text="清").first.wait_for(timeout=10000)
        assert await page.evaluate(BUSINESS) == before, "清云失败后仍清空了本机商品/订单/明细"
        assert not cloud.leaked, cloud.leaked
    finally:
        await context.close()


async def clear_retry(browser):
    cloud = FakeCloud("unknown-once")
    context, page = await fresh(browser, cloud)
    try:
        before = await page.evaluate(BUSINESS)
        await clear_steps(page)
        await page.get_by_role("button", name="一并清空云端", exact=True).click()
        await page.get_by_role("alert").filter(has_text="清").first.wait_for(timeout=10000)
        operations = await page.evaluate(PENDING)
        assert len(operations) == 1 and operations[0]["state"] == "unknown", f"unknown 操作未保留：{operations}"
        operation_id = operations[0]["operationId"]
        assert await page.evaluate(BUSINESS) == before, "未知结果丢失本机数据"
        await page.reload(wait_until="networkidle")
        await page.get_by_role("button", name="更多", exact=True).click()
        await page.locator(".list-item", has_text="设置与同步").click()
        await expect(page.get_by_text(operation_id, exact=False)).to_be_visible()
        await page.get_by_role("button", name="重试同一次清空", exact=True).click()
        await page.get_by_role("button", name="一并清空云端", exact=True).click()
        await expect(page.get_by_role("dialog", name="同时清空云端账本？", exact=True)).to_have_count(0, timeout=10000)
        attempts = [r["body"]["p_operation_id"] for r in cloud.requests
                    if r["path"].endswith("/yh_clear_ledger")]
        assert attempts == [operation_id, operation_id], f"未知结果重试换了 operationId：{attempts}"
        assert (await page.evaluate(BUSINESS))["products"] == [], "清云成功后未清本机"
        assert await page.evaluate(PENDING) == [], "本机清成功后未完成清空回执"
        assert not cloud.leaked, cloud.leaked
    finally:
        await context.close()


async def reconnect(browser, *, stale: bool = False):
    cloud = FakeCloud()
    remote_product = {**product("p-local", "云端同号商品"), "priceList": 200}
    cloud.remote_rows = [{"id": "product:p-local", "record_id": "p-local", "kind": "product",
                          "ledger": LEDGER, "data": remote_product, "updated_at": 1780000000000,
                          "record_updated_at": 1780000000000, "deleted": False}]
    context, page = await fresh(browser, cloud, paused=True)
    try:
        await expect(page.get_by_label("Project URL", exact=True)).to_have_value(FAKE_URL)
        await page.get_by_role("button", name="准备重连", exact=True).click()
        dialog = page.get_by_role("dialog", name="重新接入前核对差异", exact=True)
        await dialog.wait_for()
        confirm = dialog.get_by_role("button", name="确认差异并重新接入", exact=True)
        await expect(confirm).to_be_disabled()
        assert not cloud.writes, f"只读预览触发云写：{cloud.writes}"
        assert await page.evaluate("localStorage.getItem('yh-sync-disabled')") == "1"
        await expect(dialog.get_by_text("保留商品-local", exact=False).first).to_be_visible()
        await expect(dialog.get_by_text("云端同号商品", exact=False).first).to_be_visible()
        await dialog.get_by_role("radio", name="采用本机版本").first.check()
        await expect(confirm).to_be_enabled()
        if stale:
            await page.evaluate("""async () => {
              const database=await new Promise((resolve,reject)=>{
                const r=indexedDB.open('yanhuo-erp');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
              });
              try { await new Promise((resolve,reject)=>{
                const tx=database.transaction('syncMeta','readwrite');const store=tx.objectStore('syncMeta');
                const req=store.get('state');req.onsuccess=()=>store.put({...req.result,generation:req.result.generation+1});
                tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
              });}finally{database.close();}
            }""")
            await confirm.click()
            await expect(dialog.get_by_role("alert")).to_contain_text("重新预览")
            await expect(confirm).to_be_disabled()
            assert await page.evaluate("localStorage.getItem('yh-sync-disabled')") == "1"
            assert not cloud.writes, "过期预览恢复了云写"
        else:
            await confirm.click()
            await expect(dialog).to_have_count(0, timeout=10000)
            assert await page.evaluate("localStorage.getItem('yh-sync-disabled')") is None
            assert (await page.evaluate(BUSINESS))["products"][0]["name"] == "保留商品-local"
        assert not cloud.leaked, cloud.leaked
    finally:
        await context.close()


async def reconnect_stale(browser):
    await reconnect(browser, stale=True)


CASES = {"undo": undo, "undo-no-download": undo_without_download, "clear-busy": clear_busy,
         "clear-failure": clear_failure, "clear-retry": clear_retry,
         "reconnect": reconnect, "reconnect-stale": reconnect_stale}


async def main() -> int:
    parsed = urlparse(BASE)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit(f"只允许 loopback 测试地址：{BASE}")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", action="append", choices=list(CASES))
    chosen = parser.parse_args().case or list(CASES)
    failures = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        try:
            for name in chosen:
                try:
                    await CASES[name](browser)
                    print(f"PASS {name}")
                except Exception as error:
                    failures.append(name)
                    print(f"FAIL {name}: {error}")
        finally:
            await browser.close()
    print(f"{len(chosen) - len(failures)}/{len(chosen)} passed; failed={failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
