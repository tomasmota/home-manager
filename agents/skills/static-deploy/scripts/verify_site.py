#!/usr/bin/env python3

# pyright: reportMissingImports=false

from __future__ import annotations

import argparse
import json
import socket
import ssl
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request

SCRIPT_DIR = Path(__file__).resolve().parent
PACKAGE_ROOT = SCRIPT_DIR.parent
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from scripts.cf_common import fail, run_main  # noqa: E402

DOH_ENDPOINTS = {
    "cloudflare": "https://cloudflare-dns.com/dns-query",
    "google": "https://dns.google/resolve",
}
USER_AGENT = "static-deploy-scripts/1.0"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify Pages URLs, external DNS, and HTTPS content.")
    parser.add_argument("--hostname", help="Custom hostname to verify")
    parser.add_argument("--deployment-url", help="Pages deployment or pages.dev URL to verify")
    parser.add_argument("--expect-substring", action="append", default=[], help="Substring that should appear in the response body")
    parser.add_argument("--timeout", type=int, default=20, help="Network timeout in seconds")
    parser.add_argument("--max-bytes", type=int, default=32768, help="Maximum number of bytes to read per response")
    return parser.parse_args()


def fetch_url(url: str, timeout: int, max_bytes: int) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept-Encoding": "identity",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(max_bytes)
            text = body.decode("utf-8", errors="replace")
            return {
                "status": response.status,
                "final_url": response.geturl(),
                "content_sample": text[:500],
                "content_text": text,
                "headers": dict(response.headers.items()),
            }
    except urllib.error.HTTPError as exc:
        body = exc.read(max_bytes)
        text = body.decode("utf-8", errors="replace")
        return {
            "status": exc.code,
            "final_url": exc.geturl(),
            "content_sample": text[:500],
            "content_text": text,
            "headers": dict(exc.headers.items()),
        }


def doh_lookup(endpoint: str, name: str, record_type: str, timeout: int) -> list[str]:
    if endpoint.endswith("dns-query"):
        query = urllib.parse.urlencode({"name": name, "type": record_type})
        url = f"{endpoint}?{query}"
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/dns-json",
                "User-Agent": USER_AGENT,
            },
        )
    else:
        query = urllib.parse.urlencode({"name": name, "type": record_type})
        url = f"{endpoint}?{query}"
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})

    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))

    answers = payload.get("Answer") or []
    results = []
    for answer in answers:
        data = answer.get("data")
        if data:
            results.append(data.rstrip("."))
    return results


def decode_chunked(body: bytes) -> bytes:
    output = bytearray()
    cursor = 0
    while True:
        line_end = body.find(b"\r\n", cursor)
        if line_end == -1:
            return bytes(output)
        size_bytes = body[cursor:line_end].split(b";", 1)[0]
        chunk_size = int(size_bytes or b"0", 16)
        cursor = line_end + 2
        if chunk_size == 0:
            return bytes(output)
        output.extend(body[cursor:cursor + chunk_size])
        cursor += chunk_size + 2


def fetch_https_via_address(hostname: str, address: str, timeout: int, max_bytes: int) -> dict:
    context = ssl.create_default_context()
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    raw_body = bytearray()

    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect((address, 443))
        with context.wrap_socket(sock, server_hostname=hostname) as tls:
            request = (
                f"GET / HTTP/1.1\r\n"
                f"Host: {hostname}\r\n"
                f"User-Agent: {USER_AGENT}\r\n"
                "Accept: text/html,*/*\r\n"
                "Accept-Encoding: identity\r\n"
                "Connection: close\r\n\r\n"
            )
            tls.sendall(request.encode("ascii"))
            while len(raw_body) < max_bytes:
                chunk = tls.recv(min(4096, max_bytes - len(raw_body)))
                if not chunk:
                    break
                raw_body.extend(chunk)

    head, _, body = bytes(raw_body).partition(b"\r\n\r\n")
    header_lines = head.decode("iso-8859-1", errors="replace").split("\r\n")
    status_line = header_lines[0] if header_lines else "HTTP/1.1 0"
    parts = status_line.split(" ", 2)
    status = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    headers = {}
    for line in header_lines[1:]:
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        headers[key.strip().lower()] = value.strip()

    if headers.get("transfer-encoding", "").lower() == "chunked":
        body = decode_chunked(body)

    text = body.decode("utf-8", errors="replace")
    return {
        "status": status,
        "address": address,
        "headers": headers,
        "content_sample": text[:500],
        "content_text": text,
    }


def main() -> dict:
    args = parse_args()
    if not args.hostname and not args.deployment_url:
        fail("missing_input", "Provide --hostname, --deployment-url, or both.")

    result: dict[str, object] = {"ok": True}
    checks = []

    if args.deployment_url:
        deployment = fetch_url(args.deployment_url, args.timeout, args.max_bytes)
        deployment["matches_expected_content"] = all(
            substring in deployment["content_text"] for substring in args.expect_substring
        )
        deployment.pop("content_text", None)
        result["deployment"] = deployment
        checks.append(200 <= deployment["status"] < 400 and deployment["matches_expected_content"])

    if args.hostname:
        dns = {}
        addresses = []
        for provider, endpoint in DOH_ENDPOINTS.items():
            provider_addresses = {
                "A": doh_lookup(endpoint, args.hostname, "A", args.timeout),
                "AAAA": doh_lookup(endpoint, args.hostname, "AAAA", args.timeout),
            }
            dns[provider] = provider_addresses
            addresses.extend(provider_addresses["A"])
            addresses.extend(provider_addresses["AAAA"])
        unique_addresses = sorted(set(addresses), key=lambda value: (":" in value, value))
        if not unique_addresses:
            fail(
                "dns_resolution_failed",
                f"Public DNS resolvers could not resolve {args.hostname}.",
                details={"hostname": args.hostname, "dns": dns},
                exit_code=2,
            )

        https = None
        errors = []
        for address in unique_addresses:
            try:
                https = fetch_https_via_address(args.hostname, address, args.timeout, args.max_bytes)
                break
            except OSError as exc:
                errors.append({"address": address, "error": str(exc)})

        if https is None:
            fail(
                "https_verification_failed",
                f"Could not establish HTTPS to {args.hostname} using resolved public addresses.",
                details={"hostname": args.hostname, "dns": dns, "errors": errors},
                exit_code=3,
            )
            raise AssertionError("unreachable")

        https["matches_expected_content"] = all(
            substring in https["content_text"] for substring in args.expect_substring
        )
        https.pop("content_text", None)
        result["hostname"] = {
            "name": args.hostname,
            "dns": dns,
            "addresses": unique_addresses,
            "https": https,
            "connection_errors": errors,
        }
        checks.append(200 <= https["status"] < 400 and https["matches_expected_content"])

    result["ok"] = all(checks)
    return result


if __name__ == "__main__":
    run_main(main)
