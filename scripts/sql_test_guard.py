"""Validate the SQL test destination before psql can open a connection."""

import argparse
import ipaddress
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
from urllib.parse import unquote, urlsplit


DATABASE_NAME = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_-]{0,62}\Z")


def validate_database_url(url, expected_database):
    if not DATABASE_NAME.fullmatch(expected_database or ""):
        raise ValueError("SQL test requires a simple expected database name")
    # libpq decodes query option names (%68ostaddr etc.); none are needed by this gate.
    if not url or any(character.isspace() for character in url) or "?" in url or "#" in url:
        raise ValueError("SQL test URL must have no whitespace, query options or fragment")
    parsed = urlsplit(url)
    if parsed.scheme not in ("postgres", "postgresql") or parsed.path != "/" + expected_database:
        raise ValueError("SQL test URL database must exactly match the expected database name")
    if parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("SQL test URL must use literal loopback or verified localhost")
    port = parsed.port or 5432
    if not 1 <= port <= 65535:
        raise ValueError("SQL test URL port is invalid")
    if parsed.hostname == "localhost":
        addresses = {item[4][0] for item in socket.getaddrinfo("localhost", port, type=socket.SOCK_STREAM)}
        if not addresses or not all(ipaddress.ip_address(address).is_loopback for address in addresses):
            raise ValueError("localhost must resolve entirely to loopback")
    return url


def main(argv=None, environ=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, help="exact dedicated test database name")
    parser.add_argument("--psql", default="psql", help="psql executable, optionally an absolute portable path")
    args = parser.parse_args(argv)
    environment = dict(os.environ if environ is None else environ)
    url = environment.get("YH_TEST_DATABASE_URL", "")
    try:
        validate_database_url(url, args.database)
    except (ValueError, OSError):
        # Do not echo a malformed URI: it might contain credentials.
        print("FAIL: SQL pre-connect guard rejected the URL/database configuration", file=sys.stderr)
        return 2
    child = environment.copy()
    # libpq environment may otherwise add an address/service despite an explicit URI host.
    for name in ("PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS"):
        child.pop(name, None)
    parsed = urlsplit(url)
    if parsed.password is not None:
        child["PGPASSWORD"] = unquote(parsed.password)
        # Keep the password out of command lines and SQL's identity diagnostic output.
        authority = parsed.netloc
        userinfo, server = authority.rsplit("@", 1)
        username = userinfo.split(":", 1)[0]
        url = parsed._replace(netloc=username + "@" + server).geturl()
    child["YH_TEST_DATABASE_URL"] = url
    fixture = Path(__file__).resolve().parents[1] / "supabase" / "tests" / "stability.sql"
    command = [args.psql, "-X", "-w", "-v", "ON_ERROR_STOP=1", "-v",
               "yh_test_database_name=" + args.database, "--dbname", url, "-f", str(fixture)]
    try:
        result = subprocess.run(command, env=child, check=False)
    except OSError:
        print("FAIL: psql could not be started; no SQL test result", file=sys.stderr)
        return 2
    return result.returncode
