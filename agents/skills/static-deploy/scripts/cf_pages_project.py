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
    get_account_id_argument,
    require_api_token,
    run_main,
    summarize_project,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Get or create a deterministic Cloudflare Pages project.")
    parser.add_argument("--project-name", required=True, help="Cloudflare Pages project name")
    parser.add_argument("--production-branch", default="main", help="Production branch name")
    parser.add_argument("--zone", default=DEFAULT_ZONE_NAME, help="Cloudflare zone name")
    parser.add_argument("--account-id", help="Cloudflare account ID")
    return parser.parse_args()


def main() -> dict:
    args = parse_args()
    token = require_api_token()
    client = CloudflareClient(token)
    zone = client.get_zone(args.zone)
    account_id = client.resolve_account_id(zone, get_account_id_argument(args.account_id))
    created, project = client.ensure_pages_project(account_id, args.project_name, args.production_branch)
    summary = summarize_project(project)

    return {
        "ok": True,
        "created": created,
        "account_id": account_id,
        "project": summary,
        "pages_url": f"https://{summary['subdomain']}" if summary.get("subdomain") else None,
    }


if __name__ == "__main__":
    run_main(main)
