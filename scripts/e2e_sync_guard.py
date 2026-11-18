"""Validate destructive E2E inputs without browser or network side effects."""

from dataclasses import dataclass
import re
from urllib.parse import urlsplit


class UnsafeSyncConfiguration(ValueError):
    """Configuration cannot be proven safe for a test-only ledger."""


@dataclass(frozen=True)
class SyncRunConfig:
    use_mock: bool
    url: str
    key: str
    ledger: str


def validate_sync_run_config(environment, builtin_source):
    keys = ("SYNC_URL", "SYNC_KEY", "SYNC_LEDGER")
    present = [key for key in keys if key in environment]
    if not present:
        return SyncRunConfig(True, "", "", "")
    if len(present) != len(keys):
        raise UnsafeSyncConfiguration("SYNC_URL, SYNC_KEY and SYNC_LEDGER must be set together")
    if environment.get("SYNC_TEST_ONLY") != "1":
        raise UnsafeSyncConfiguration("real E2E requires explicit SYNC_TEST_ONLY=1")
    url, key, ledger = (environment[name].strip() for name in keys)
    try:
        parsed = urlsplit(url)
        valid = (parsed.scheme == "https" and parsed.hostname and not parsed.username
                 and not parsed.password and parsed.path in ("", "/")
                 and not parsed.query and not parsed.fragment and key and ledger)
    except ValueError:
        valid = False
    if not valid:
        raise UnsafeSyncConfiguration("real E2E requires a project HTTPS origin and nonempty key/ledger")
    if builtin_source is None:
        raise UnsafeSyncConfiguration("cannot read syncDefaults.ts; refusing real E2E")
    matches = re.findall(r"\bledgerKey\s*:\s*(['\"])(.*?)\1", builtin_source)
    if len(matches) != 1 or not matches[0][1].strip():
        raise UnsafeSyncConfiguration("cannot prove built-in ledger identity; refusing real E2E")
    if ledger == matches[0][1].strip():
        raise UnsafeSyncConfiguration("refusing destructive E2E against built-in production ledger")
    return SyncRunConfig(False, url.rstrip("/"), key, ledger)
