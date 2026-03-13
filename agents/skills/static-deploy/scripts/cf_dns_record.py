#!/usr/bin/env python3

# pyright: reportMissingImports=false

from __future__ import annotations

import argparse
from pathlib import Path
import sys

SCRIPT_DIR = Path(__file__).resolve().parent
PACKAGE_ROOT = SCRIPT_DIR.parent
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from scripts.cf_common import (  # noqa: E402
    CloudflareClient,
    DEFAULT_ZONE_NAME,
    fail,
    is_managed_record,
    managed_comment,
    require_api_token,
    run_main,
    summarize_dns_record,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ensure a proxied CNAME points a hostname at a Pages project.")
    parser.add_argument("--name", required=True, help="DNS hostname, such as demo.tomasmota.dev")
    parser.add_argument("--target", required=True, help="Expected CNAME target, such as tm-demo.pages.dev")
    parser.add_argument("--project-name", help="Project name used for managed DNS comments")
    parser.add_argument("--zone", default=DEFAULT_ZONE_NAME, help="Cloudflare zone name")
    parser.add_argument("--zone-id", help="Cloudflare zone ID")
    parser.add_argument("--ttl", type=int, default=1, help="DNS TTL; use 1 for auto")
    parser.add_argument("--proxied", dest="proxied", action="store_true", default=True, help="Proxy the CNAME through Cloudflare")
    parser.add_argument("--no-proxied", dest="proxied", action="store_false", help="Leave the CNAME unproxied")
    return parser.parse_args()


def fail_conflict(name: str, records: list[dict], message: str) -> None:
    fail(
        "dns_conflict",
        message,
        details={
            "name": name,
            "records": [summarize_dns_record(record) for record in records],
        },
        exit_code=2,
    )


def main() -> dict:
    args = parse_args()
    token = require_api_token()
    client = CloudflareClient(token)
    zone = client.get_zone(args.zone)
    zone_id = args.zone_id or zone["id"]
    records = client.list_dns_records(zone_id, args.name)
    desired_comment = managed_comment(args.project_name)

    if not records:
        record = client.create_dns_record(
            zone_id,
            {
                "type": "CNAME",
                "name": args.name,
                "content": args.target,
                "proxied": args.proxied,
                "ttl": args.ttl,
                "comment": desired_comment,
            },
        )
        return {
            "ok": True,
            "action": "created",
            "record": summarize_dns_record(record),
        }

    if len(records) > 1:
        fail_conflict(args.name, records, f"Multiple DNS records already exist for {args.name}; refusing to guess.")

    record = records[0]
    if record.get("type") != "CNAME":
        fail_conflict(args.name, records, f"A non-CNAME DNS record already exists for {args.name}.")

    content_matches = record.get("content") == args.target
    safe_to_update = content_matches or is_managed_record(record, args.project_name)
    if not safe_to_update:
        fail_conflict(
            args.name,
            records,
            f"A CNAME already exists for {args.name} but it points elsewhere and is not marked as managed by static-deploy.",
        )

    updates = {
        key: value
        for key, value in {
            "content": args.target,
            "proxied": args.proxied,
            "ttl": args.ttl,
            "comment": desired_comment,
        }.items()
        if record.get(key) != value
    }

    if not updates:
        return {
            "ok": True,
            "action": "unchanged",
            "record": summarize_dns_record(record),
        }

    updated = client.patch_dns_record(zone_id, record["id"], updates)
    return {
        "ok": True,
        "action": "updated",
        "record": summarize_dns_record(updated),
        "updated_fields": sorted(updates.keys()),
    }


if __name__ == "__main__":
    run_main(main)
