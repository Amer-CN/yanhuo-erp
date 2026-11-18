import http.client
import http.server
import json
import socket
import sys
import threading
import unittest
from pathlib import Path
from urllib.request import ProxyHandler, Request, build_opener

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

try:
    import protocol_guard
except ImportError:
    protocol_guard = None


class ProtocolGuardTests(unittest.TestCase):
    def require_guard(self):
        self.assertIsNotNone(protocol_guard, "protocol_guard helper has not been implemented")
        return protocol_guard

    def test_reconcile_projection_uses_fixed_fields_filters_local_settings_and_c_order(self):
        guard = self.require_guard()
        cloud_rows = [
            {"id": "é", "record_id": "é", "kind": "product", "data": {"n": 1},
             "updated_at": 1, "record_updated_at": 2, "deleted": False,
             "ledger": "ledger-a", "schema_version": 2, "clear_epoch": 0, "device_id": "d"},
            {"id": "setting:deviceId", "record_id": "deviceId", "kind": "setting", "data": {"v": "local"},
             "updated_at": 3, "record_updated_at": 4, "deleted": False, "ledger": "ledger-a"},
            {"id": "z", "record_id": "z", "kind": "product", "data": {"n": 3},
             "updated_at": 5, "record_updated_at": 6, "deleted": False, "ledger": "ledger-a"},
            {"id": "setting:theme", "record_id": "theme", "kind": "setting", "data": {"v": "dark"},
             "updated_at": 7, "record_updated_at": 8, "deleted": False, "ledger": "ledger-a"},
            {"id": "a", "record_id": "a", "kind": "product", "data": {"n": 0},
             "updated_at": 0, "record_updated_at": 0, "deleted": False, "ledger": "ledger-a"},
        ]

        projection = guard.reconcile_projection(cloud_rows)

        self.assertEqual([row["id"] for row in projection], ["a", "setting:theme", "z", "é"])
        self.assertNotIn("setting:deviceId", [row["id"] for row in projection])
        self.assertEqual(set(projection[0]), {
            "id", "record_id", "kind", "data", "updated_at", "record_updated_at", "deleted"
        })
        self.assertTrue(all("ledger" not in row and "clear_epoch" not in row for row in projection))

    def test_protocol_config_rejects_non_loopback_and_secret_keys(self):
        guard = self.require_guard()
        valid = {"YH_PROTOCOL_TEST_URL": "http://127.0.0.1:54321", "YH_PROTOCOL_TEST_KEY": "sb_publishable_test"}
        self.assertEqual(guard.validate_protocol_config(valid), ("http://127.0.0.1:54321", "sb_publishable_test"))
        for unsafe in (
            {**valid, "YH_PROTOCOL_TEST_URL": "https://127.0.0.1:54321"},
            {**valid, "YH_PROTOCOL_TEST_URL": "https://example.com"},
            {**valid, "YH_PROTOCOL_TEST_KEY": "sb_secret_test"},
            {**valid, "YH_PROTOCOL_TEST_KEY": "unknown-key-format"},
            {**valid, "YH_PROTOCOL_TEST_URL": "http://user:pass@127.0.0.1:54321"},
        ):
            with self.subTest(unsafe=unsafe), self.assertRaises(ValueError):
                guard.validate_protocol_config(unsafe)

    def test_response_drop_proxy_forwards_only_target_rpc_and_drops_real_response(self):
        guard = self.require_guard()
        observations = []

        class UpstreamHandler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                observations.append((self.path, body, self.headers.get("apikey"), self.headers.get("x-ledger-key")))
                payload = json.dumps({"operationId": "op", "pushedCount": 1}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, format, *args):
                pass

        upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        upstream.daemon_threads = True
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        try:
            with guard.ResponseDropProxy(f"http://127.0.0.1:{upstream.server_port}") as proxy:
                request = Request(
                    proxy.origin + "/rest/v1/rpc/yh_reconcile_push",
                    data=b'{"p_expected":[],"p_rows":[]}',
                    headers={"Content-Type": "application/json", "apikey": "anon-test",
                             "x-ledger-key": "ledger-test"},
                    method="POST",
                )
                opener = build_opener(ProxyHandler({}))
                with self.assertRaises(http.client.RemoteDisconnected):
                    opener.open(request, timeout=3)
                proxy.assert_upstream_response_received()
            self.assertEqual(len(observations), 1)
            self.assertEqual(observations[0][0], "/rest/v1/rpc/yh_reconcile_push")
            self.assertEqual(observations[0][1], b'{"p_expected":[],"p_rows":[]}')
            self.assertEqual(observations[0][2:], ("anon-test", "ledger-test"))
        finally:
            upstream.shutdown()
            upstream.server_close()
            upstream_thread.join(timeout=3)

    def test_response_drop_proxy_refuses_https_and_non_loopback_origins(self):
        guard = self.require_guard()
        for origin in ("https://127.0.0.1:54321", "http://example.com:54321"):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                guard.ResponseDropProxy(origin)


if __name__ == "__main__":
    unittest.main()
