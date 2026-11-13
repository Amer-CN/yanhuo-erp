import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from e2e_sync_guard import SyncRunConfig, UnsafeSyncConfiguration, validate_sync_run_config

BUILTIN = "export const DEFAULT_SYNC = { ledgerKey: 'public-ledger' } as const;"


class SyncRunGuardTests(unittest.TestCase):
    def test_mock_mode_only_when_no_sync_variables_are_present(self):
        self.assertEqual(validate_sync_run_config({}, BUILTIN), SyncRunConfig(True, "", "", ""))

    def test_partial_configuration_is_rejected(self):
        with self.assertRaisesRegex(UnsafeSyncConfiguration, "must be set together"):
            validate_sync_run_config({"SYNC_URL": "https://test.supabase.co"}, BUILTIN)

    def test_real_mode_requires_test_only_opt_in(self):
        env = {"SYNC_URL": "https://test.supabase.co", "SYNC_KEY": "test", "SYNC_LEDGER": "test-ledger"}
        with self.assertRaisesRegex(UnsafeSyncConfiguration, "SYNC_TEST_ONLY=1"):
            validate_sync_run_config(env, BUILTIN)

    def test_builtin_ledger_is_rejected(self):
        env = {"SYNC_URL": "https://test.supabase.co", "SYNC_KEY": "test", "SYNC_LEDGER": "public-ledger", "SYNC_TEST_ONLY": "1"}
        with self.assertRaisesRegex(UnsafeSyncConfiguration, "built-in production ledger"):
            validate_sync_run_config(env, BUILTIN)

    def test_unreadable_or_unparseable_builtin_source_fails_closed(self):
        env = {"SYNC_URL": "https://test.supabase.co", "SYNC_KEY": "test", "SYNC_LEDGER": "test-ledger", "SYNC_TEST_ONLY": "1"}
        for source in (None, "", "DEFAULT_SYNC = {};", "ledgerKey: ''", "ledgerKey: 'one'; ledgerKey: 'two'"):
            with self.subTest(source=source), self.assertRaises(UnsafeSyncConfiguration):
                validate_sync_run_config(env, source)

    def test_rejects_http_userinfo_path_and_empty_key(self):
        base = {"SYNC_KEY": "test", "SYNC_LEDGER": "test-ledger", "SYNC_TEST_ONLY": "1"}
        for url in ("http://test.supabase.co", "https://user:pass@test.supabase.co", "https://test.supabase.co/path"):
            with self.subTest(url=url), self.assertRaises(UnsafeSyncConfiguration):
                validate_sync_run_config({**base, "SYNC_URL": url}, BUILTIN)
        with self.assertRaises(UnsafeSyncConfiguration):
            validate_sync_run_config({"SYNC_URL":"https://test.supabase.co", "SYNC_KEY":" ", "SYNC_LEDGER":"x", "SYNC_TEST_ONLY":"1"}, BUILTIN)

    def test_accepts_only_explicit_test_ledger(self):
        env = {"SYNC_URL": "https://test.supabase.co/", "SYNC_KEY": "test", "SYNC_LEDGER": "test-ledger", "SYNC_TEST_ONLY": "1"}
        self.assertEqual(validate_sync_run_config(env, BUILTIN), SyncRunConfig(False, "https://test.supabase.co", "test", "test-ledger"))


if __name__ == "__main__":
    unittest.main()
