"""独立 loopback Supabase/PostgREST 的 anon 协议验收；缺环境为失败，绝不当 skip。

先在独立测试库应用 prepare + finalize（或新库 schema.sql）。仅接受完整的
YH_PROTOCOL_TEST_URL / YH_PROTOCOL_TEST_KEY，不启动服务、不应用 SQL、不使用 service key。
每次随机 ledger，最终仅对本次 ledger 调幂等清空 RPC，保留测试墓碑/receipt。
SQL 故障回滚与迁移保全见 supabase/tests/stability.sql 及迁移 fixture；本脚本验证实际 HTTP。
"""

from concurrent.futures import ThreadPoolExecutor
import http.client
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from protocol_guard import (ResponseDropProxy, reconcile_projection,
                            validate_loopback_http_origin, validate_protocol_config)


def load_config(environ):
    return validate_protocol_config(environ)


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

    def request(self, method, route, ledger=None, body=None, epoch=None, origin=None):
        if not route.startswith("/rest/v1/") or "#" in route:
            raise ValueError("协议请求必须是固定本地 REST 路径")
        if origin is not None:
            validate_loopback_http_origin(origin)
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
        request = urllib.request.Request((origin or self.origin) + route, data=data, method=method, headers=headers)
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

    def reconcile_push(self, ledger, operation_id, expected, rows, epoch=None, *, origin=None):
        return self.request("POST", "/rest/v1/rpc/yh_reconcile_push", ledger,
                            {"p_operation_id": operation_id, "p_expected": expected, "p_rows": rows},
                            epoch, origin=origin)

    def write(self, ledger, row_id, epoch=0, *, target=None):
        row = {"id": row_id, "record_id": row_id, "ledger": target or ledger,
               "kind": "product", "data": {"name": row_id}, "updated_at": int(time.time() * 1000),
               "record_updated_at": 1, "schema_version": 2, "clear_epoch": epoch}
        return self.request("POST", "/rest/v1/yh_records?on_conflict=ledger,id", ledger, [row], epoch)

    def write_reconcile_row(self, ledger, row_id, epoch=0, *, name=None, target=None):
        row = reconcile_row(target or ledger, row_id, epoch, name)
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


def reconcile_row(ledger, row_id, epoch=0, name=None):
    kind, record_id = row_id.split(":", 1)
    return {"id": row_id, "record_id": record_id, "ledger": ledger, "kind": kind,
            "data": {"name": name or row_id}, "updated_at": int(time.time() * 1000),
            "record_updated_at": 1, "schema_version": 2, "clear_epoch": epoch,
            "device_id": "protocol-test", "deleted": False}


def require_reconcile_receipt(receipt, operation_id, pushed_count, message):
    require(isinstance(receipt, dict) and receipt.get("operationId") == operation_id
            and receipt.get("pushedCount") == pushed_count,
            f"{message}: receipt 身份/数量不符: {receipt}")


def read_reconcile_receipt(client, ledger, operation_id, pushed_count):
    rows = client.ok("GET", "/rest/v1/yh_reconcile_operations?select=operation_id,pushed_count&operation_id=eq." +
                     urllib.parse.quote(operation_id, safe=""), ledger)
    require(len(rows) == 1 and rows[0].get("operation_id") == operation_id
            and rows[0].get("pushed_count") == pushed_count,
            f"只读 reconcile receipt 缺失或内容不符: {rows}")
    return rows[0]


def run_reconcile_protocol(client, ledger_a, ledger_b):
    # A real successful RPC is the feature probe; protocolVersion alone is insufficient.
    ledger_probe = client.new_ledger("reconcile-probe")
    probe_id = str(uuid.uuid4())
    status, probe = client.reconcile_push(ledger_probe, probe_id, [], [])
    require(200 <= status < 300, f"yh_reconcile_push 未实际可用: {status}: {probe}")
    require_reconcile_receipt(probe, probe_id, 0, "空账本真实 RPC 探针")
    read_reconcile_receipt(client, ledger_probe, probe_id, 0)

    denied(client.request("POST", "/rest/v1/rpc/yh_reconcile_push", body={
        "p_operation_id": str(uuid.uuid4()), "p_expected": [], "p_rows": []}),
        "reconcile 空 header", "SYNC_LEDGER_HEADER_REQUIRED")
    forged_receipt_id = str(uuid.uuid4())
    denied(client.request("POST", "/rest/v1/yh_reconcile_operations", ledger_a, [{
        "ledger": ledger_a, "operation_id": forged_receipt_id, "pushed_count": 1,
    }]), "伪造 reconcile receipt")
    require(client.ok("GET", "/rest/v1/yh_reconcile_operations?select=operation_id&operation_id=eq." +
                      forged_receipt_id, ledger_a) == [], "拒绝的伪造 receipt 不得落库")

    # The first expected snapshot is stale after another HTTP writer commits.
    ledger_drift = client.new_ledger("reconcile-drift")
    original_expected = reconcile_projection(client.rows(ledger_drift))
    drift_row = reconcile_row(ledger_drift, "product:pending-drift")
    drift_operation = str(uuid.uuid4())
    status, concurrent_writer = client.write_reconcile_row(ledger_drift, "product:concurrent-writer")
    require(200 <= status < 300, f"并发设备正常写入失败: {status}: {concurrent_writer}")
    denied(client.reconcile_push(ledger_drift, drift_operation, original_expected, [drift_row]),
           "p_expected 漂移保护", "SYNC_RECONNECT_BASELINE_CHANGED")
    require(client.ok("GET", "/rest/v1/yh_reconcile_operations?select=operation_id&operation_id=eq." +
                      drift_operation, ledger_drift) == [], "基线变化拒绝后不能创建 reconcile receipt")
    current = client.rows(ledger_drift)
    require(not any(row["id"] == drift_row["id"] for row in current),
            "baseline changed 拒绝后 p_rows 不得部分落库")
    require(any(row["id"] == "product:concurrent-writer" for row in current),
            "baseline changed 拒绝不得回滚另一设备已提交数据")
    refreshed_expected = reconcile_projection(current)
    status, result = client.reconcile_push(ledger_drift, drift_operation, refreshed_expected, [drift_row])
    require(200 <= status < 300, f"重新预览后 reconcile 正常提交失败: {status}: {result}")
    require_reconcile_receipt(result, drift_operation, 1, "重新预览后的 reconcile")
    read_reconcile_receipt(client, ledger_drift, drift_operation, 1)

    # A row tagged for a different ledger must fail, then the valid ledger-bound retry succeeds.
    ledger_wrong = client.new_ledger("reconcile-wrong-ledger")
    wrong_operation = str(uuid.uuid4())
    wrong_row = reconcile_row(ledger_a, "product:wrong-ledger")
    denied(client.reconcile_push(ledger_wrong, wrong_operation,
                                reconcile_projection(client.rows(ledger_wrong)), [wrong_row]),
           "reconcile wrong ledger row", "SYNC_LEDGER_HEADER_MISMATCH")
    require(client.ok("GET", "/rest/v1/yh_reconcile_operations?select=operation_id&operation_id=eq." +
                      wrong_operation, ledger_wrong) == [], "wrong ledger 拒绝后不能创建 receipt")
    require(not any(row["id"] == wrong_row["id"] for row in client.rows(ledger_wrong)),
            "wrong ledger 拒绝后不能插入行")
    correct_row = reconcile_row(ledger_wrong, wrong_row["id"])
    status, result = client.reconcile_push(ledger_wrong, wrong_operation, [], [correct_row])
    require(200 <= status < 300, f"wrong ledger 拒绝后的正确重试失败: {status}: {result}")
    require_reconcile_receipt(result, wrong_operation, 1, "wrong ledger 修复后")

    # A stale clear epoch fails without a receipt or row, and current-epoch retry works.
    ledger_epoch = client.new_ledger("reconcile-old-epoch")
    status, seed_result = client.write_reconcile_row(ledger_epoch, "product:epoch-seed")
    require(200 <= status < 300, f"旧 epoch fixture 写入失败: {status}: {seed_result}")
    clear_receipt = client.clear(ledger_epoch, str(uuid.uuid4()))
    current_epoch = clear_receipt["clearEpoch"]
    expected_after_clear = reconcile_projection(client.rows(ledger_epoch))
    epoch_operation = str(uuid.uuid4())
    epoch_row = reconcile_row(ledger_epoch, "product:epoch-recovered", 0)
    denied(client.reconcile_push(ledger_epoch, epoch_operation, expected_after_clear, [epoch_row], 0),
           "reconcile old epoch row", "SYNC_CLEAR_EPOCH_MISMATCH")
    require(client.ok("GET", "/rest/v1/yh_reconcile_operations?select=operation_id&operation_id=eq." +
                      epoch_operation, ledger_epoch) == [], "旧 epoch 拒绝后不能创建 receipt")
    require(not any(row["id"] == epoch_row["id"] for row in client.rows(ledger_epoch)),
            "old epoch 拒绝后不能插入行")
    recovered_row = reconcile_row(ledger_epoch, epoch_row["id"], current_epoch)
    status, result = client.reconcile_push(ledger_epoch, epoch_operation, expected_after_clear,
                                          [recovered_row], current_epoch)
    require(200 <= status < 300, f"old epoch 拒绝后的当前代重试失败: {status}: {result}")
    require_reconcile_receipt(result, epoch_operation, 1, "当前 epoch 恢复")

    # The client loses only the real server response; a second client changes data before retry.
    ledger_lost = client.new_ledger("reconcile-response-lost")
    existing_id = "product:response-lost-existing"
    status, seed_result = client.write_reconcile_row(ledger_lost, existing_id, name="before reconcile")
    require(200 <= status < 300, f"响应丢失 fixture 写入失败: {status}: {seed_result}")
    peer = ProtocolClient(client.origin, client.key, client.prefix)
    lost_expected = reconcile_projection(client.rows(ledger_lost))
    first_value = reconcile_row(ledger_lost, existing_id, name="first reconcile value")
    added_value = reconcile_row(ledger_lost, "product:response-lost-added", name="first reconcile add")
    lost_rows = [first_value, added_value]
    lost_operation = str(uuid.uuid4())
    with ResponseDropProxy(client.origin) as proxy:
        try:
            client.reconcile_push(ledger_lost, lost_operation, lost_expected, lost_rows, origin=proxy.origin)
        except http.client.RemoteDisconnected:
            pass
        else:
            raise AssertionError("response-drop proxy must make the client observe a lost response")
        first_receipt = proxy.assert_upstream_response_received()
    require_reconcile_receipt(first_receipt, lost_operation, 2, "代理丢弃前收到的真实服务端响应")
    read_reconcile_receipt(client, ledger_lost, lost_operation, 2)

    # Another device's upsert modifies the old row and adds a row after the first commit.
    peer_existing_status, peer_existing_result = peer.write_reconcile_row(
        ledger_lost, existing_id, name="later peer value")
    require(200 <= peer_existing_status < 300,
            f"另一设备更新已 reconcile 行失败: {peer_existing_status}: {peer_existing_result}")
    peer_added_status, peer_added_result = peer.write_reconcile_row(
        ledger_lost, "product:response-lost-later", name="later peer row")
    require(200 <= peer_added_status < 300,
            f"另一设备在响应丢失后新增行失败: {peer_added_status}: {peer_added_result}")
    current_rows = client.rows(ledger_lost)
    require(next(row for row in current_rows if row["id"] == existing_id)["data"]["name"] == "later peer value",
            "后续设备更新必须先持久化")
    require(any(row["id"] == "product:response-lost-later" for row in current_rows),
            "后续设备新增行必须先持久化")
    before_retry_rows = current_rows
    retry_status, retry_receipt = client.reconcile_push(ledger_lost, lost_operation, lost_expected, lost_rows)
    require(200 <= retry_status < 300, f"同 operationId receipt-first 重试失败: {retry_status}: {retry_receipt}")
    require_reconcile_receipt(retry_receipt, lost_operation, 2, "响应丢失后的 receipt-first 重试")
    after_retry_rows = client.rows(ledger_lost)
    require(after_retry_rows == before_retry_rows,
            "receipt-first 重试必须逐字段保持其他设备后来提交的完整账本快照")
    require(next(row for row in after_retry_rows if row["id"] == existing_id)["data"]["name"] == "later peer value",
            "其他设备的更新值必须在 receipt-first 重试后完整保留")
    require(next(row for row in after_retry_rows if row["id"] == "product:response-lost-later")["data"]["name"] == "later peer row",
            "其他设备新增行的完整值必须在 receipt-first 重试后保留")

    # Even after a clear changes the generation, the same operation returns its first receipt only.
    later_clear = client.clear(ledger_lost, str(uuid.uuid4()))
    require(later_clear["clearEpoch"] > 0, "响应丢失用例后续 clear 代际必须推进")
    before_cleared_retry_rows = client.rows(ledger_lost)
    cleared_retry_status, cleared_retry = client.reconcile_push(
        ledger_lost, lost_operation, lost_expected, lost_rows, 0)
    require(200 <= cleared_retry_status < 300,
            f"clear 后同号 receipt-first 重试失败: {cleared_retry_status}: {cleared_retry}")
    require_reconcile_receipt(cleared_retry, lost_operation, 2, "clear 后同 operationId receipt-first")
    after_cleared_retry_rows = client.rows(ledger_lost)
    require(after_cleared_retry_rows == before_cleared_retry_rows,
            "clear 后 receipt-first 重试必须逐字段保持完整墓碑/marker 快照")
    require(all(row["deleted"] for row in after_cleared_retry_rows if row["kind"] != "ledger"),
            "clear 后 receipt-first 重试不能写入/复活旧数据")
    read_reconcile_receipt(client, ledger_lost, lost_operation, 2)
    cross_ledger_receipt = client.ok("GET", "/rest/v1/yh_reconcile_operations?select=operation_id,pushed_count&operation_id=eq." +
                                     urllib.parse.quote(lost_operation, safe=""), ledger_b)
    require(cross_ledger_receipt == [], "reconcile receipt 不可跨账本读取")
    print("PASS reconcile actual RPC / baseline drift / wrong-ledger / old-epoch / response-loss receipt-first")


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
    run_reconcile_protocol(client, ledger_a, ledger_b)

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
