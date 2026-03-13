#!/usr/bin/env python3

# pyright: reportMissingImports=false

from __future__ import annotations

import sys
import argparse
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PACKAGE_ROOT = SCRIPT_DIR.parent
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from scripts.cf_common import (  # noqa: E402
    CloudflareClient,
    DEFAULT_ZONE_NAME,
    REQUIRED_PERMISSIONS,
    fail,
    get_account_id_argument,
    is_managed_record,
    require_api_token,
    run_main,
    summarize_dns_record,
    summarize_project,
    summarize_zone,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate Cloudflare access and detect conflicts before deployment.")
    parser.add_argument("--fqdn", required=True, help="Full hostname to deploy, such as demo.tomasmota.dev")
    parser.add_argument("--project-name", required=True, help="Deterministic Cloudflare Pages project name")
    parser.add_argument("--zone", default=DEFAULT_ZONE_NAME, help="Cloudflare zone name")
    parser.add_argument("--account-id", help="Cloudflare account ID")
    return parser.parse_args()


def main() -> dict:
    args = parse_args()
    token = require_api_token()
    client = CloudflareClient(token)

    token_info = client.verify_token()
    zone = client.get_zone(args.zone)
    account_id = client.resolve_account_id(zone, get_account_id_argument(args.account_id))
    projects = client.list_pages_projects(account_id)
    dns_records = client.list_dns_records(zone["id"], args.fqdn)
    dns_write_probe = client.probe_dns_write_access(zone["id"])
    project = client.get_pages_project(account_id, args.project_name)
    domain_matches = client.find_domain_attachments(account_id, args.fqdn, projects=projects)
    expected_target = ((project or {}).get("subdomain")) or f"{args.project_name}.pages.dev"

    conflicts = []
    if len(domain_matches) > 1:
        conflicts.append(
            {
                "code": "multiple_domain_attachments",
                "message": f"{args.fqdn} is attached to multiple Pages projects.",
                "matches": domain_matches,
            }
        )
    elif domain_matches and domain_matches[0]["project"] != args.project_name:
        conflicts.append(
            {
                "code": "domain_attached_elsewhere",
                "message": f"{args.fqdn} is already attached to another Pages project.",
                "matches": domain_matches,
            }
        )

    if len(dns_records) > 1:
        conflicts.append(
            {
                "code": "multiple_dns_records",
                "message": f"Multiple DNS records already exist for {args.fqdn}; refusing to guess.",
                "records": [summarize_dns_record(record) for record in dns_records],
            }
        )
    elif len(dns_records) == 1:
        record = dns_records[0]
        if record.get("type") != "CNAME":
            conflicts.append(
                {
                    "code": "dns_type_conflict",
                    "message": f"{args.fqdn} already has a non-CNAME DNS record and cannot safely be reused.",
                    "records": [summarize_dns_record(record)],
                }
            )
        elif record.get("content") != expected_target and not is_managed_record(record, args.project_name):
            conflicts.append(
                {
                    "code": "dns_target_conflict",
                    "message": f"{args.fqdn} already points to a different DNS target.",
                    "expected_target": expected_target,
                    "records": [summarize_dns_record(record)],
                }
            )

    result = {
        "ok": len(conflicts) == 0,
        "zone": summarize_zone(zone),
        "account_id": account_id,
        "token": {
            "status": token_info.get("status"),
            "expires_on": token_info.get("expires_on"),
            "not_before": token_info.get("not_before"),
            "wrangler_login_required": False,
        },
        "required_env": ["CLOUDFLARE_API_TOKEN"],
        "optional_env": ["CLOUDFLARE_ACCOUNT_ID"],
        "required_permissions": REQUIRED_PERMISSIONS,
        "pages": {
            "project_name": args.project_name,
            "project_exists": project is not None,
            "project": summarize_project(project) if project else None,
            "pages_project_count": len(projects),
            "domain_matches": domain_matches,
        },
        "dns": {
            "fqdn": args.fqdn,
            "expected_target": expected_target,
            "record_count": len(dns_records),
            "records": [summarize_dns_record(record) for record in dns_records],
            "write_access": dns_write_probe,
        },
        "conflicts": conflicts,
    }

    if conflicts:
        fail(
            "preflight_conflict",
            "Preflight detected a conflict and refused to continue.",
            details=result,
            exit_code=2,
        )

    return result


if __name__ == "__main__":
    run_main(main)
