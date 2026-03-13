#!/usr/bin/env python3

# pyright: reportMissingImports=false

from __future__ import annotations

import argparse
from pathlib import Path
import sys
import time

SCRIPT_DIR = Path(__file__).resolve().parent
PACKAGE_ROOT = SCRIPT_DIR.parent
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from scripts.cf_common import (  # noqa: E402
    CloudflareClient,
    DEFAULT_ZONE_NAME,
    fail,
    get_account_id_argument,
    require_api_token,
    run_main,
    summarize_domain,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Poll Cloudflare Pages until a custom domain becomes active.")
    parser.add_argument("--project-name", required=True, help="Cloudflare Pages project name")
    parser.add_argument("--domain", required=True, help="Custom domain to poll")
    parser.add_argument("--attempts", type=int, default=30, help="Maximum polling attempts")
    parser.add_argument("--interval", type=int, default=10, help="Seconds between polling attempts")
    parser.add_argument("--retry-validation-every", type=int, default=3, help="How often to request a domain validation retry; set to 0 to disable")
    parser.add_argument("--zone", default=DEFAULT_ZONE_NAME, help="Cloudflare zone name")
    parser.add_argument("--account-id", help="Cloudflare account ID")
    return parser.parse_args()


def main() -> dict:
    args = parse_args()
    token = require_api_token()
    client = CloudflareClient(token)
    zone = client.get_zone(args.zone)
    account_id = client.resolve_account_id(zone, get_account_id_argument(args.account_id))

    history = []
    for attempt in range(1, args.attempts + 1):
        if args.retry_validation_every > 0 and (attempt == 1 or (attempt - 1) % args.retry_validation_every == 0):
            client.retry_project_domain_validation(account_id, args.project_name, args.domain)

        domain = client.get_project_domain(account_id, args.project_name, args.domain)
        if domain is None:
            fail(
                "domain_not_found",
                f"{args.domain} is not attached to {args.project_name}.",
                details={"project_name": args.project_name, "domain": args.domain},
            )

        summary = summarize_domain(domain)
        history.append({"attempt": attempt, **summary})
        if summary["status"] == "active":
            return {
                "ok": True,
                "attempts": attempt,
                "account_id": account_id,
                "domain": summary,
                "history": history,
            }

        if attempt < args.attempts:
            time.sleep(args.interval)

    fail(
        "domain_activation_timeout",
        f"Timed out waiting for {args.domain} to become active.",
        details={
            "project_name": args.project_name,
            "domain": args.domain,
            "attempts": args.attempts,
            "interval": args.interval,
            "history": history,
        },
        exit_code=3,
    )
    raise AssertionError("unreachable")


if __name__ == "__main__":
    run_main(main)
