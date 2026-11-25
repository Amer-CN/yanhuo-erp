"""Isolate real E2E data and make cloud cleanup resumable across process restarts."""

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


RUN_KEYS = {"baseLedger", "url", "ledger", "operationId", "createdAt"}


def make_run_ledger(base_ledger: str, run_id: str) -> str:
    base = base_ledger.strip()
    run = run_id.strip()
    if not base or not run or any(char in base + run for char in "\r\n"):
        raise ValueError("test ledger namespace and run id must be nonempty single-line values")
    return f"{base}-e2e-{run}"


def build_clear_request(url: str, key: str, ledger: str, operation_id: str) -> Request:
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("clear RPC requires a project HTTPS origin")
    if not key or not ledger or not operation_id:
        raise ValueError("clear RPC requires key, ledger and operation id")
    target = f"{url.rstrip('/')}/rest/v1/rpc/yh_clear_ledger"
    body = json.dumps({"p_operation_id": operation_id}).encode("utf-8")
    headers = {
        "apikey": key,
        "x-ledger-key": ledger,
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if key.startswith("eyJ"):
        headers["Authorization"] = f"Bearer {key}"
    return Request(target, data=body, method="POST", headers=headers)


def validate_clear_receipt(payload: object, operation_id: str) -> None:
    if not isinstance(payload, dict) or payload.get("operationId") != operation_id:
        raise ValueError("clear RPC returned a malformed receipt or operationId mismatch")
    for field, minimum in (("clearedAt", 1), ("clearedCount", 0), ("clearEpoch", 0)):
        value = payload.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= 9_007_199_254_740_991:
            raise ValueError(f"clear RPC receipt has an invalid {field}")


def clear_ledger(url: str, key: str, ledger: str, operation_id: str, opener=urlopen) -> dict:
    request = build_clear_request(url, key, ledger, operation_id)
    with opener(request, timeout=20) as response:
        payload = json.loads(response.read())
    validate_clear_receipt(payload, operation_id)
    return payload


@contextmanager
def run_file_lock(path: str | Path):
    """Hold an OS lock for one real-E2E process; crashes release it automatically."""
    lock_path = Path(f"{path}.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(lock_path, "a+b")
    locked = False
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except OSError as error:
            raise RuntimeError("another E2E process owns the run file") from error
        yield
    finally:
        try:
            if locked:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def _validate_run(run: object) -> dict:
    if not isinstance(run, dict) or set(run) != RUN_KEYS:
        raise ValueError("E2E run file is malformed")
    if any(not isinstance(run.get(field), str) or not run[field] for field in RUN_KEYS):
        raise ValueError("E2E run file values must be nonempty strings")
    if not run["ledger"].startswith(f"{run['baseLedger']}-e2e-"):
        raise ValueError("E2E run ledger is outside the configured test namespace")
    try:
        datetime.fromisoformat(run["createdAt"])
    except ValueError as error:
        raise ValueError("E2E run file timestamp is invalid") from error
    return run


def save_run(path: str | Path, run: dict) -> None:
    """Atomically persist non-secret run identity so a lost response can be retried."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(_validate_run(run), ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()


def _create_run_exclusive(target: Path, run: dict) -> None:
    payload = json.dumps(_validate_run(run), ensure_ascii=False, indent=2).encode("utf-8")
    descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        target.unlink(missing_ok=True)
        raise


def load_or_create_run(path: str | Path, base_ledger: str, url: str) -> dict:
    target = Path(path)
    project_url = url.strip().rstrip("/")
    if target.exists():
        try:
            run = _validate_run(json.loads(target.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError("cannot read E2E run file; refusing to create an untracked ledger") from error
        if run["url"] != project_url:
            raise ValueError("E2E run file belongs to a different project URL")
        return run
    run = {
        "baseLedger": base_ledger.strip(),
        "url": project_url,
        "ledger": make_run_ledger(base_ledger, uuid.uuid4().hex),
        "operationId": str(uuid.uuid4()),
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    try:
        _create_run_exclusive(target, run)
    except FileExistsError:
        return load_or_create_run(target, base_ledger, project_url)
    return run


def remove_run_if_matches(path: str | Path, run: dict) -> None:
    """Delete only the identity this process actually cleaned."""
    target = Path(path)
    current = _validate_run(json.loads(target.read_text(encoding="utf-8")))
    if current != _validate_run(run):
        raise ValueError("E2E run file changed before deletion; refusing to remove it")
    target.unlink()


def _transient(error: BaseException) -> bool:
    if isinstance(error, (URLError, TimeoutError, ConnectionError)):
        return True
    return isinstance(error, HTTPError) and (error.code in (408, 429) or error.code >= 500)


def clear_run(path: str | Path, run: dict, url: str, key: str, *, opener=urlopen,
              attempts: int = 3, sleep=time.sleep) -> dict:
    """Retry only transient transport failures with the same ledger and operationId."""
    _validate_run(run)
    if run["url"] != url.strip().rstrip("/"):
        raise ValueError("E2E cleanup URL does not match the persisted run project")
    for attempt in range(attempts):
        try:
            return clear_ledger(url, key, run["ledger"], run["operationId"], opener)
        except BaseException as error:
            if not _transient(error) or attempt == attempts - 1:
                raise
            sleep(0.5 * (2 ** attempt))
    raise AssertionError("unreachable")


def run_with_cleanup(task, cleanup):
    """Preserve the primary test failure; cleanup failure is additional stderr context."""
    try:
        result = task()
    except BaseException:
        try:
            cleanup()
        except BaseException as error:
            print(f"[cleanup] 清理失败（原始测试异常已保留）：{error}", file=sys.stderr)
        raise
    cleanup()
    return result
