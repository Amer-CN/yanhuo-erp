import io
import json
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from e2e_sync_cleanup import (
    build_clear_request,
    clear_ledger,
    clear_run,
    load_or_create_run,
    make_run_ledger,
    remove_run_if_matches,
    run_file_lock,
    run_with_cleanup,
    save_run,
    validate_clear_receipt,
)


class Response:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.payload


class SyncCleanupTests(unittest.TestCase):
    def test_clear_ledger_propagates_http_and_receipt_failures(self):
        def mismatched_opener(_request, timeout):
            self.assertEqual(timeout, 20)
            return Response({"operationId": "wrong-operation"})

        with self.assertRaisesRegex(ValueError, "operationId"):
            clear_ledger("https://project.supabase.co", "key", "ledger", "op-123", mismatched_opener)

        def failed_opener(_request, timeout):
            self.assertEqual(timeout, 20)
            raise HTTPError("https://project.supabase.co", 503, "unavailable", {}, None)

        with self.assertRaises(HTTPError):
            clear_ledger("https://project.supabase.co", "key", "ledger", "op-123", failed_opener)

    def test_run_ledger_is_unique_and_scoped_to_the_configured_namespace(self):
        first = make_run_ledger("integration-tests", "run-a")
        second = make_run_ledger("integration-tests", "run-b")
        self.assertNotEqual(first, second)
        self.assertTrue(first.startswith("integration-tests"))
        self.assertTrue(second.startswith("integration-tests"))

    def test_clear_request_uses_the_ledger_scoped_idempotent_rpc(self):
        request = build_clear_request(
            "https://project.supabase.co/", "test-anon-key", "integration-tests-e2e-a", "op-123"
        )
        self.assertEqual(request.full_url, "https://project.supabase.co/rest/v1/rpc/yh_clear_ledger")
        self.assertEqual(request.get_method(), "POST")
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertEqual(headers["apikey"], "test-anon-key")
        self.assertEqual(headers["x-ledger-key"], "integration-tests-e2e-a")
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(json.loads(request.data), {"p_operation_id": "op-123"})

    def test_jwt_key_adds_bearer_authorization_without_persisting_it(self):
        request = build_clear_request("https://project.supabase.co", "eyJsecret", "ledger", "op-123")
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertEqual(headers["authorization"], "Bearer eyJsecret")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "run.json"
            run = load_or_create_run(path, "integration-tests", "https://project.supabase.co")
            save_run(path, run)
            self.assertNotIn("eyJsecret", path.read_text(encoding="utf-8"))

    def test_run_file_reuses_ledger_and_operation_after_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "run.json"
            fixed = uuid.UUID("12345678-1234-4abc-8def-1234567890ab")
            with patch("e2e_sync_cleanup.uuid.uuid4", return_value=fixed):
                first = load_or_create_run(path, "integration-tests", "https://project.supabase.co")
            second = load_or_create_run(path, "integration-tests", "https://project.supabase.co")
            self.assertEqual(second, first)
            self.assertEqual(second["url"], "https://project.supabase.co")
            self.assertEqual(second["ledger"], "integration-tests-e2e-1234567812344abc8def1234567890ab")
            self.assertEqual(second["operationId"], "12345678-1234-4abc-8def-1234567890ab")
            self.assertNotIn("key", second)

    def test_run_file_rejects_a_different_project_url(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "run.json"
            run = load_or_create_run(path, "integration-tests", "https://one.supabase.co")
            with self.assertRaisesRegex(ValueError, "URL|project|项目"):
                load_or_create_run(path, "integration-tests", "https://two.supabase.co")

        calls = []

        def opener(request, timeout):
            calls.append((json.loads(request.data), request.get_header("X-ledger-key")))
            if len(calls) == 1:
                raise HTTPError(request.full_url, 503, "unavailable", {}, None)
            if len(calls) == 2:
                raise URLError("timeout")
            return Response({"operationId": "op-123", "clearedAt": 1, "clearedCount": 3, "clearEpoch": 1})

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "run.json"
            run = {"baseLedger": "integration-tests", "url": "https://project.supabase.co",
                   "ledger": "integration-tests-e2e-a", "operationId": "op-123",
                   "createdAt": "2026-11-26T00:00:00+00:00"}
            save_run(path, run)
            receipt = clear_run(path, run, "https://project.supabase.co", "test-anon-key",
                                opener=opener, sleep=lambda _seconds: None)
            self.assertEqual(receipt["operationId"], "op-123")
            self.assertEqual(calls, [
                ({"p_operation_id": "op-123"}, "integration-tests-e2e-a"),
                ({"p_operation_id": "op-123"}, "integration-tests-e2e-a"),
                ({"p_operation_id": "op-123"}, "integration-tests-e2e-a"),
            ])
            self.assertEqual(load_or_create_run(path, "integration-tests", "https://project.supabase.co"), run)

    def test_clear_receipt_must_match_the_requested_operation(self):
        valid = {"operationId": "op-123", "clearedAt": 1, "clearedCount": 3, "clearEpoch": 1}
        validate_clear_receipt(valid, "op-123")
        for payload in (
            None,
            [],
            {},
            {"operationId": "other", "clearedAt": 1, "clearedCount": 3, "clearEpoch": 1},
            {"operationId": "op-123"},
            {"operationId": "op-123", "clearedAt": 0, "clearedCount": 3, "clearEpoch": 1},
            {"operationId": "op-123", "clearedAt": 1, "clearedCount": -1, "clearEpoch": 1},
            {"operationId": "op-123", "clearedAt": 1, "clearedCount": 3, "clearEpoch": None},
        ):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                validate_clear_receipt(payload, "op-123")

    def test_run_file_lock_rejects_a_concurrent_process(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "run.json"
            code = (
                "import sys; "
                "sys.path.insert(0, sys.argv[1]); "
                "from e2e_sync_cleanup import run_file_lock; "
                "from pathlib import Path; "
                "exec(\"with run_file_lock(Path(sys.argv[2])):\\n    print('acquired')\")"
            )
            with run_file_lock(path):
                result = subprocess.run([sys.executable, "-c", code,
                                         str(Path(__file__).resolve().parents[1] / "scripts"), str(path)],
                                        capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("another E2E process", result.stderr)

    def test_remove_run_refuses_to_delete_a_different_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "run.json"
            original = load_or_create_run(path, "integration-tests", "https://project.supabase.co")
            replacement = {**original, "operationId": "replacement-operation"}
            save_run(path, replacement)
            with self.assertRaisesRegex(ValueError, "changed|变化|不同"):
                remove_run_if_matches(path, original)
            self.assertEqual(load_or_create_run(path, "integration-tests", "https://project.supabase.co"), replacement)
            remove_run_if_matches(path, replacement)
            self.assertFalse(path.exists())

        primary = RuntimeError("browser assertion failed")
        cleanup_error = RuntimeError("cleanup unavailable")

        def task():
            raise primary

        def cleanup():
            raise cleanup_error

        stderr = io.StringIO()
        with patch("sys.stderr", stderr):
            with self.assertRaises(RuntimeError) as caught:
                run_with_cleanup(task, cleanup)
        self.assertIs(caught.exception, primary)
        self.assertIn("cleanup unavailable", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
