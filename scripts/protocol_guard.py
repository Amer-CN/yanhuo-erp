"""Offline guards and a one-shot loopback response-drop proxy for protocol E2E."""

import base64
import http.client
import http.server
import ipaddress
import json
import socket
import threading
from urllib.parse import urlsplit


LOCAL_RECONCILE_SETTINGS = frozenset((
    "deviceId", "deviceName", "operatorSelf", "sync-unknown-kinds",
))
RECONCILE_PROJECTION_FIELDS = (
    "id", "record_id", "kind", "data", "updated_at", "record_updated_at", "deleted",
)
RECONCILE_RPC_PATH = "/rest/v1/rpc/yh_reconcile_push"
MAX_HTTP_BYTES = 1_048_576


def _require_loopback_host(host, port):
    host = host.lower()
    if host == "localhost":
        addresses = {item[4][0] for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)}
        if not addresses or not all(ipaddress.ip_address(item).is_loopback for item in addresses):
            raise ValueError("localhost 必须全部解析为 loopback")
        return
    try:
        local = ipaddress.ip_address(host).is_loopback
    except ValueError:
        local = False
    if not local:
        raise ValueError("拒绝非 loopback 服务；不得连接生产或真实 Supabase")


def validate_protocol_config(environ):
    """Return a strictly local HTTP origin and an anon/publishable key."""
    url = environ.get("YH_PROTOCOL_TEST_URL", "").strip()
    key = environ.get("YH_PROTOCOL_TEST_KEY", "").strip()
    if not url or not key:
        raise ValueError("未验证：YH_PROTOCOL_TEST_URL/KEY 必须全部配置（仅 loopback 独立测试服务）")
    parsed = urlsplit(url)
    if (parsed.scheme != "http" or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
        raise ValueError("测试 URL 必须是无凭据、无路径、无查询参数的 loopback HTTP origin")
    port = parsed.port
    _require_loopback_host(parsed.hostname, port or (443 if parsed.scheme == "https" else 80))
    if key.startswith("sb_publishable_"):
        pass
    elif key.count(".") == 2:
        try:
            payload = key.split(".")[1]
            claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        except (ValueError, UnicodeError) as exc:
            raise ValueError("JWT key 无法确认 anon 角色") from exc
        if not isinstance(claims, dict) or claims.get("role") != "anon":
            raise ValueError("JWT key 必须声明 anon；拒绝 service_role/authenticated")
    else:
        raise ValueError("仅允许 anon JWT 或 sb_publishable_ key")
    return url.rstrip("/"), key


def reconcile_projection(rows):
    """Build the exact yh_reconcile_push p_expected projection from REST rows."""
    if not isinstance(rows, list):
        raise TypeError("reconcile source rows must be a list")
    projected = []
    for row in rows:
        if not isinstance(row, dict):
            raise TypeError("reconcile source row must be an object")
        if row.get("kind") == "setting" and row.get("record_id") in LOCAL_RECONCILE_SETTINGS:
            continue
        projected.append({field: row[field] for field in RECONCILE_PROJECTION_FIELDS})
    projected.sort(key=lambda row: row["id"].encode("utf-8"))
    ids = [row["id"] for row in projected]
    if len(ids) != len(set(ids)):
        raise ValueError("reconcile source contains duplicate ids")
    return projected


def validate_loopback_http_origin(origin):
    """Validate the local cleartext origin used by the response-drop proxy."""
    parsed = urlsplit(origin)
    if (parsed.scheme != "http" or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("响应丢弃代理仅支持无凭据 loopback HTTP origin")
    port = parsed.port or 80
    _require_loopback_host(parsed.hostname, port)
    return parsed, port


class ResponseDropProxy:
    """Forward one reconcile RPC to a pinned loopback origin, then drop its response."""

    def __init__(self, upstream_origin):
        parsed, port = validate_loopback_http_origin(upstream_origin)
        self._upstream_host = parsed.hostname
        self._upstream_port = port
        self._upstream_origin = upstream_origin.rstrip("/")
        self._lock = threading.Lock()
        self._served = False
        self._response = None
        self._error = None
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                owner._handle(self)

            def log_message(self, format, *args):
                pass

        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self.origin = "http://127.0.0.1:%d" % self._server.server_port
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._entered = False

    def __enter__(self):
        if self._entered:
            raise RuntimeError("response-drop proxy cannot be entered twice")
        self._entered = True
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc, traceback):
        if self._entered:
            self._server.shutdown()
            self._server.server_close()
            self._thread.join(timeout=5)
            self._entered = False
        return False

    @property
    def upstream_response(self):
        with self._lock:
            if self._response is None:
                return None
            return self._response[0], self._response[1]

    def assert_upstream_response_received(self):
        response = self.upstream_response
        if response is None:
            raise AssertionError("proxy did not receive a complete upstream HTTP response")
        status, value = response
        if not 200 <= status < 300:
            raise AssertionError("upstream reconcile RPC returned non-success status %d" % status)
        if not isinstance(value, dict):
            raise AssertionError("upstream reconcile RPC response was not a JSON object")
        return value

    def _handle(self, handler):
        with self._lock:
            if self._served:
                handler.send_error(409)
                return
            self._served = True

        if handler.path != RECONCILE_RPC_PATH:
            with self._lock:
                self._error = "unexpected request path"
            handler.send_error(403)
            return
        try:
            length_text = handler.headers.get("Content-Length")
            if length_text is None:
                raise ValueError("request body length missing")
            length = int(length_text)
            if length < 0 or length > MAX_HTTP_BYTES:
                raise ValueError("request body outside limit")
            body = handler.rfile.read(length)
            if len(body) != length:
                raise ValueError("incomplete request body")
            headers = {"Content-Type": handler.headers.get("Content-Type", "application/json"),
                       "Accept": "application/json", "Accept-Encoding": "identity",
                       "Connection": "close"}
            for name in ("apikey", "Authorization", "x-ledger-key", "x-yh-clear-epoch"):
                value = handler.headers.get(name)
                if value is not None:
                    headers[name] = value
            connection = http.client.HTTPConnection(
                self._upstream_host, self._upstream_port, timeout=20
            )
            try:
                connection.request("POST", RECONCILE_RPC_PATH, body=body, headers=headers)
                response = connection.getresponse()
                declared_length = response.length
                response_body = response.read(MAX_HTTP_BYTES + 1)
                if len(response_body) > MAX_HTTP_BYTES:
                    raise ValueError("upstream response outside limit")
                if declared_length is not None and len(response_body) != declared_length:
                    raise ValueError("incomplete upstream response")
                text = response_body.decode("utf-8")
                value = json.loads(text) if text else None
                with self._lock:
                    self._response = (response.status, value)
            finally:
                connection.close()
            # The real PostgREST response has been fully read; never write it to the client.
            handler.close_connection = True
            try:
                handler.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            handler.connection.close()
        except Exception as exc:
            with self._lock:
                self._error = type(exc).__name__
            handler.close_connection = True
            try:
                handler.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            handler.connection.close()
