"""独立 loopback Supabase/PostgREST 的 anon 协议验收；缺环境为失败，绝不当 skip。

先在独立测试库应用 prepare + finalize（或新库 schema.sql）。仅接受完整的
YH_PROTOCOL_TEST_URL / YH_PROTOCOL_TEST_KEY，不启动服务、不应用 SQL、不使用 service key。
每次随机 ledger，最终仅对本次 ledger 调幂等清空 RPC，保留测试墓碑/receipt。
SQL 故障回滚与迁移保全见 supabase/tests/stability.sql 及迁移 fixture；本脚本验证实际 HTTP。
"""

import base64
from concurrent.futures import ThreadPoolExecutor
import ipaddress
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def load_config(environ):
    url = environ.get("YH_PROTOCOL_TEST_URL", "").strip()
    key = environ.get("YH_PROTOCOL_TEST_KEY", "").strip()
    if not url or not key:
        raise ValueError("未验证：YH_PROTOCOL_TEST_URL/KEY 必须全部配置（仅 loopback 独立测试服务）")
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
        raise ValueError("测试 URL 必须是无凭据、无路径、无查询参数的 HTTP(S) loopback origin")
    _ = parsed.port  # Invalid ports also fail closed.
    host = parsed.hostname.lower()
    if host == "localhost":
        addresses = {item[4][0] for item in socket.getaddrinfo(host, parsed.port or 80)}
        if not addresses or not all(ipaddress.ip_address(item).is_loopback for item in addresses):
            raise ValueError("localhost 必须全部解析为 loopback")
    else:
        try:
            local = ipaddress.ip_address(host).is_loopback
        except ValueError:
            local = False
        if not local:
            raise ValueError("拒绝非 loopback 服务；不得连接生产或真实 Supabase")
    if key.startswith("sb_secret_"):
        raise ValueError("仅允许 anon/publishable key，拒绝 secret key")
    if key.count(".") == 2:
        try:
            payload = key.split(".")[1]
            claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        except (ValueError, UnicodeError) as exc:
            raise ValueError("JWT key 无法确认 anon 角色") from exc
        if not isinstance(claims, dict) or claims.get("role") != "anon":
            raise ValueError("JWT key 必须声明 anon；拒绝 service_role/authenticated")
    return url.rstrip("/"), key


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("拒绝 HTTP 重定向，防止将测试 key/ledger 发送到其他 origin")


class ProtocolClient:
    def __init__(self, origin, key, prefix):
        self.origin = origin
        self.key = key
        self.prefix = prefix
        self.ledgers = set()

    def new_ledger(self, suffix):
        ledger = self.prefix + "-" + suffix
        self.ledgers.add(ledger)
        return ledger

    def request(self, method, route, ledger=None, body=None, epoch=None):
        if not route.startswith("/rest/v1/") or "#" in route:
            raise ValueError("协议请求必须是固定本地 REST 路径")
        headers = {"apikey": self.key, "Content-Type": "application/json", "Accept": "application/json"}
        if self.key.count(".") == 2:
            headers["Authorization"] = "Bearer " + self.key
        if ledger is not None:
            headers["x-ledger-key"] = ledger
        if epoch is not None:
            headers["x-yh-clear-epoch"] = str(epoch)
        if method in ("POST", "PATCH") and route.startswith("/rest/v1/yh_records"):
            headers["Prefer"] = "resolution=merge-duplicates,return=representation"
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(self.origin + route, data=data, method=method, headers=headers)
        # Ignore host proxy settings; deny redirects before any key can leave this origin.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            response = opener.open(request, timeout=20)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            content = response.read(1_048_577)
            if len(content) > 1_048_576:
                raise RuntimeError("协议响应超过 1 MiB 测试限制")
            text = content.decode("utf-8")
            try:
                value = json.loads(text) if text else None
            except ValueError:
                value = {"message": text[:500]}
            return response.status, value

    def ok(self, method, route, ledger=None, body=None, epoch=None):
        status, result = self.request(method, route, ledger, body, epoch)
        if not 200 <= status < 300:
            raise AssertionError(f"{method} {route.split('?')[0]} 返回 {status}: {result}")
        return result

    def capabilities(self, ledger):
        return self.ok("POST", "/rest/v1/rpc/yh_sync_capabilities", ledger, {})

    def rows(self, ledger):
        return self.ok("GET", "/rest/v1/yh_records?select=*&order=id.asc", ledger)

    def clear(self, ledger, operation_id):
        return self.ok("POST", "/rest/v1/rpc/yh_clear_ledger", ledger, {"p_operation_id": operation_id})

    def write(self, ledger, row_id, epoch=0, *, target=None):
        row = {"id": row_id, "record_id": row_id, "ledger": target or ledger,
               "kind": "product", "data": {"name": row_id}, "updated_at": int(time.time() * 1000),
               "record_updated_at": 1, "schema_version": 2, "clear_epoch": epoch}
        return self.request("POST", "/rest/v1/yh_records?on_conflict=ledger,id", ledger, [row], epoch)

    def patch(self, ledger, row_id, body, epoch=None):
        route = "/rest/v1/yh_records?id=eq." + urllib.parse.quote(row_id, safe="")
        return self.request("PATCH", route, ledger, body, epoch)

    def cleanup_ledger(self, ledger):
        if ledger not in self.ledgers or not ledger.startswith(self.prefix + "-"):
            raise ValueError("拒绝清理本次随机 prefix 之外的账本")
        return self.clear(ledger, str(uuid.uuid4()))


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def denied(response, message, diagnostic=None):
    status, result = response
    require(400 <= status < 500, f"{message}: 预期 4xx，实际 {status}: {result}")
    if diagnostic:
        require(diagnostic in json.dumps(result), f"{message}: 缺少 {diagnostic}: {result}")


def patched_row(response, row_id, message):
    status, result = response
    require(200 <= status < 300 and isinstance(result, list) and len(result) == 1
            and result[0].get("id") == row_id,
            f"{message}: PATCH 必须实际命中已有行，实际 {status}: {result}")
    return result[0]


def run_protocol(client):
    ledger_a = client.new_ledger("a")
    ledger_b = client.new_ledger("b")
    cap = client.capabilities(ledger_a)
    print("[capabilities]", json.dumps(cap, ensure_ascii=False))
    require(cap.get("protocolVersion") == 2 and cap.get("conflictTarget") == "ledger,id", "需要协议 v2 与复合冲突支持")
    require(cap.get("ledgerScoped") is True and cap.get("clearRpcEnabled") is True,
            "准备阶段尚未完成：需人工确认两端升级后应用 finalize，当前未执行协议验收")
    require(cap.get("clearEpoch") == 0, "随机新账本必须 epoch=0")
    print("[stage] finalized; random ledgers:", client.prefix)

    for ledger in (ledger_a, ledger_b):
        require(client.write(ledger, "product:shared")[0] < 300, "跨账本相同 id 应能写入")
        require(client.write(ledger, "product:shared")[0] < 300, "同账本重复 upsert 应成功")
        require(len(client.rows(ledger)) == 1, "同账本重发不得重复；RLS 仅见本账本")
    patched = patched_row(client.patch(ledger_a, "product:shared", {"data": {"name": "patched-before-clear"}}, 0),
                          "product:shared", "清空前已有行 PATCH")
    require(patched["data"]["name"] == "patched-before-clear", "PATCH 返回已更新值")
    require(next(r for r in client.rows(ledger_a) if r["id"] == "product:shared")["data"]["name"]
            == "patched-before-clear", "PATCH 更新必须已持久化")
    denied(client.write(ledger_a, "product:cross", target=ledger_b), "跨账本写入")
    status, rows = client.request("GET", "/rest/v1/yh_records?ledger=eq." + urllib.parse.quote(ledger_b), ledger_a)
    require(status == 200 and rows == [], "RLS 不能读到其他账本")
    denied(client.request("DELETE", "/rest/v1/yh_records", ledger_a), "物理删除")
    for route, body in (("/rest/v1/rpc/yh_sync_capabilities", {}),
                        ("/rest/v1/rpc/yh_clear_ledger", {"p_operation_id": str(uuid.uuid4())})):
        denied(client.request("POST", route, body=body), "空 header RPC", "SYNC_LEDGER_HEADER_REQUIRED")
    denied(client.request("POST", "/rest/v1/yh_clear_operations", ledger_a,
                          {"ledger": ledger_a, "operation_id": str(uuid.uuid4()), "cleared_at": 1,
                           "cleared_count": 0, "clear_epoch": 0}), "伪造 receipt")
    denied(client.request("POST", "/rest/v1/yh_ledger_state", ledger_a,
                          {"ledger": ledger_a, "clear_epoch": 999}), "直接推进 epoch")
    print("PASS compound conflict / RLS / grants / missing header")

    operation = str(uuid.uuid4())
    receipt = client.clear(ledger_a, operation)
    require(receipt.get("operationId") == operation and receipt.get("clearedCount") == 1, "清空凭证身份/数量")
    epoch = receipt.get("clearEpoch")
    require(isinstance(epoch, int) and epoch > 0 and receipt.get("clearedAt", 0) > 0, "服务端 epoch/时间")
    require(client.capabilities(ledger_a)["clearEpoch"] == epoch, "能力必须返回本账本 epoch")
    rows = client.rows(ledger_a)
    require(next(r for r in rows if r["id"] == "product:shared")["deleted"] is True, "旧行应为墓碑")
    marker = next(r for r in rows if r["kind"] == "ledger")
    require(marker["data"]["clearEpoch"] == epoch and not marker["deleted"], "marker 与 epoch 同事务")
    denied(client.write(ledger_a, "product:stale", 0), "旧 epoch INSERT", "SYNC_CLEAR_EPOCH_MISMATCH")
    denied(client.patch(ledger_a, "product:shared", {"deleted": False}),
           "无 epoch header 的旧 PATCH", "SYNC_CLEAR_EPOCH_MISMATCH")
    denied(client.patch(ledger_a, "product:shared", {"deleted": False}, 0),
           "旧 epoch header 的已有行 PATCH", "SYNC_CLEAR_EPOCH_MISMATCH")
    denied(client.patch(ledger_a, "product:shared", {"deleted": False, "clear_epoch": 0}, epoch),
           "新 header 不能放行旧行 epoch", "SYNC_CLEAR_EPOCH_MISMATCH")
    patched_row(client.patch(ledger_a, "product:shared", {"data": {"name": "patched-tombstone"}}, epoch),
                "product:shared", "新 epoch header 可更新已有墓碑")
    require(next(r for r in client.rows(ledger_a) if r["id"] == "product:shared")["deleted"] is True,
            "合法 PATCH 不得意外复活墓碑")
    require(client.write(ledger_a, "product:new", epoch)[0] < 300, "清空后用新 epoch 可记新单")
    require(client.clear(ledger_a, operation) == receipt, "重试同一 operation 返回第一次结果")
    require(next(r for r in client.rows(ledger_a) if r["id"] == "product:new")["deleted"] is False, "同 id 重试不能删新单")
    receipt_rows = client.ok("GET", "/rest/v1/yh_clear_operations?operation_id=eq." + operation, ledger_a)
    require(len(receipt_rows) == 1 and receipt_rows[0]["clear_epoch"] == epoch, "可查询第一次已提交 receipt")
    require(client.ok("GET", "/rest/v1/yh_clear_operations", ledger_b) == [], "receipt 不可跨账本读取")
    require(client.rows(ledger_b)[0]["deleted"] is False and client.capabilities(ledger_b)["clearEpoch"] == 0, "A 清空不影响 B")
    denied(client.request("POST", "/rest/v1/yh_records?on_conflict=id", ledger_b,
                          [{"id": "product:legacy", "record_id": "legacy", "ledger": ledger_b,
                            "kind": "product", "updated_at": 1}], 0), "旧单列 conflict target 必须失败")
    print("PASS atomic clear / receipt / epoch / existing-row PATCH / same-operation retry preserves new data")

    # Exercise UPDATE row-lock scheduling separately from INSERT. Omitting clear_epoch
    # deliberately makes PATCH inherit the row value; only the request header proves
    # the caller observed the epoch. Both requests start independently at a barrier.
    for suffix, request_epoch in (("patch-no-header", None), ("patch-old-epoch", 0)):
        ledger_patch = client.new_ledger(suffix)
        row_id = "product:existing"
        require(client.write(ledger_patch, row_id)[0] < 300, "PATCH race existing-row fixture")
        barrier = threading.Barrier(2)
        operation = str(uuid.uuid4())
        def clear_patch_race():
            barrier.wait(timeout=10)
            return client.clear(ledger_patch, operation)
        def patch_race():
            barrier.wait(timeout=10)
            return client.patch(ledger_patch, row_id,
                                {"deleted": False, "data": {"name": "racing-patch"}}, request_epoch)
        with ThreadPoolExecutor(max_workers=2) as pool:
            clear_future = pool.submit(clear_patch_race)
            patch_future = pool.submit(patch_race)
            patch_receipt, patch_result = clear_future.result(), patch_future.result()
        if 200 <= patch_result[0] < 300:
            patched = patched_row(patch_result, row_id, suffix + " 清空前 PATCH")
            require(patched["data"]["name"] == "racing-patch" and patched["clear_epoch"] == 0,
                    "获准的并发 PATCH 必须在清空前更新已有行")
        else:
            denied(patch_result, suffix + " 并发 PATCH 拒绝", "SYNC_CLEAR_EPOCH_MISMATCH")
        patch_rows = client.rows(ledger_patch)
        existing = [r for r in patch_rows if r["id"] == row_id]
        require(len(existing) == 1 and existing[0]["deleted"] is True
                and existing[0]["clear_epoch"] == patch_receipt["clearEpoch"],
                "并发已有行 PATCH 不能在清空后复活或丢失墓碑")
        require(patch_receipt.get("operationId") == operation and patch_receipt.get("clearedCount") == 1,
                "PATCH race 清空凭证应包含唯一已有业务行")
        require(client.capabilities(ledger_patch)["clearEpoch"] == patch_receipt["clearEpoch"],
                "PATCH race 能力与墓碑/receipt epoch 一致")
        print("PASS independent concurrent HTTP clear/PATCH existing row:", suffix)

    # Independent HTTP requests race against the same ledger. No timing-based success inference:
    # write may precede clear and be tombstoned, or follow clear and be explicitly rejected.
    ledger_race = client.new_ledger("race")
    require(client.write(ledger_race, "product:before")[0] < 300, "race fixture")
    barrier = threading.Barrier(2)
    def clear_race():
        barrier.wait(timeout=10)
        return client.clear(ledger_race, str(uuid.uuid4()))
    def write_race():
        barrier.wait(timeout=10)
        return client.write(ledger_race, "product:racing", 0)
    with ThreadPoolExecutor(max_workers=2) as pool:
        clear_future = pool.submit(clear_race)
        write_future = pool.submit(write_race)
        race_receipt, write_result = clear_future.result(), write_future.result()
    if write_result[0] >= 300:
        denied(write_result, "并发 stale 写拒绝", "SYNC_CLEAR_EPOCH_MISMATCH")
    require(all(r["deleted"] for r in client.rows(ledger_race) if r["kind"] != "ledger"), "并发旧写不得在清空后复活")
    barrier = threading.Barrier(2)
    with ThreadPoolExecutor(max_workers=2) as pool:
        operations = [str(uuid.uuid4()), str(uuid.uuid4())]
        def concurrent_clear(op):
            barrier.wait(timeout=10)
            return client.clear(ledger_race, op)
        results = list(pool.map(concurrent_clear, operations))
    epochs = sorted(r["clearEpoch"] for r in results)
    require(epochs[0] > race_receipt["clearEpoch"] and epochs[1] > epochs[0], "不同 operation 并发必须串行、epoch 严格增长")
    require(client.capabilities(ledger_race)["clearEpoch"] == epochs[1], "能力 epoch 为最后一次提交")
    print("PASS independent concurrent HTTP clear/write and clear/clear requests")


def main():
    try:
        origin, key = load_config(os.environ)
    except (ValueError, RuntimeError, OSError) as exc:
        print("FAIL:", exc, file=sys.stderr)
        return 2
    client = ProtocolClient(origin, key, "yh-protocol-" + uuid.uuid4().hex)
    passed = False
    try:
        run_protocol(client)
        passed = True
    except Exception as exc:
        # Never print request headers or the configured key.
        print("FAIL:", str(exc).replace(key, "[REDACTED]"), file=sys.stderr)
    finally:
        cleanup_failures = []
        for ledger in sorted(client.ledgers):
            try:
                client.cleanup_ledger(ledger)
            except Exception as exc:
                cleanup_failures.append(ledger)
                print("[cleanup failed]", ledger, str(exc).replace(key, "[REDACTED]"), file=sys.stderr)
        if cleanup_failures:
            passed = False
        print("[cleanup] only this run's random ledgers; tombstones/receipts retained")
    if passed:
        print("PASS actual loopback anon HTTP protocol; SQL migrations/rollback and long transaction lock scheduling need separate SQL verification")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
