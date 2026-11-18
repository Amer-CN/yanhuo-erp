import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

try:
    import sql_test_guard
except ImportError:
    sql_test_guard = None


class SqlTestGuardTests(unittest.TestCase):
    def guard(self):
        self.assertIsNotNone(sql_test_guard, "SQL pre-connect guard is required")
        return sql_test_guard

    def test_accepts_only_matching_simple_database_at_loopback(self):
        guard = self.guard()
        for host in ("127.0.0.1", "[::1]"):
            url = f"postgresql://owner@{host}:55432/yh_stability_test"
            self.assertEqual(guard.validate_database_url(url, "yh_stability_test"), url)
        with self.assertRaises(ValueError):
            guard.validate_database_url("postgresql://owner@127.0.0.1:55432/other", "yh_stability_test")

    def test_rejects_query_options_including_encoded_host_overrides_before_connection(self):
        guard = self.guard()
        base = "postgresql://owner@127.0.0.1:55432/yh_stability_test"
        for suffix in ("?host=192.0.2.1", "?%68ostaddr=192.0.2.1", "?%73ervice=production",
                       "?sslmode=require", "?", "#fragment", "/extra", "%2fother"):
            with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                guard.validate_database_url(base + suffix, "yh_stability_test")

    def test_rejects_non_loopback_and_encoded_database_without_dns(self):
        guard = self.guard()
        with patch("socket.getaddrinfo", side_effect=AssertionError("unexpected DNS")):
            for url in ("postgresql://owner@192.0.2.1/yh_stability_test",
                        "postgresql://owner@example.com/yh_stability_test",
                        "postgresql://owner@127.0.0.1/yh_stability%5ftest",
                        "postgresql://owner@127.0.0.1/yh_stability_test\n"):
                with self.subTest(url=url), self.assertRaises(ValueError):
                    guard.validate_database_url(url, "yh_stability_test")

    def test_localhost_must_resolve_entirely_to_loopback(self):
        guard = self.guard()
        with patch("socket.getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.0.2.1", 55432))]):
            with self.assertRaises(ValueError):
                guard.validate_database_url("postgresql://owner@localhost:55432/yh_stability_test", "yh_stability_test")

    def test_safe_run_strips_url_password_and_libpq_routing_overrides(self):
        guard = self.guard()
        with patch("subprocess.run") as spawn:
            spawn.return_value.returncode = 0
            result = guard.main(["--database", "yh_stability_test"], {
                "YH_TEST_DATABASE_URL": "postgresql://owner:local-test-password@127.0.0.1:55432/yh_stability_test",
                "PGHOSTADDR": "192.0.2.1", "PGSERVICE": "untrusted", "PGOPTIONS": "untrusted",
            })
        self.assertEqual(result, 0)
        command = spawn.call_args.args[0]
        child_env = spawn.call_args.kwargs["env"]
        self.assertNotIn("local-test-password", " ".join(command))
        self.assertEqual(child_env["PGPASSWORD"], "local-test-password")
        self.assertEqual(child_env["YH_TEST_DATABASE_URL"], "postgresql://owner@127.0.0.1:55432/yh_stability_test")
        self.assertNotIn("PGHOSTADDR", child_env)
        self.assertNotIn("PGSERVICE", child_env)
        self.assertNotIn("PGOPTIONS", child_env)

    def test_unsafe_configuration_never_launches_psql(self):
        guard = self.guard()
        with patch("subprocess.run") as spawn:
            result = guard.main(["--database", "yh_stability_test"], {
                "YH_TEST_DATABASE_URL": "postgresql://owner@localhost/yh_stability_test?%68ostaddr=192.0.2.1"
            })
        self.assertEqual(result, 2)
        spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
