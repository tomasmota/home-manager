#!/usr/bin/env python3

# pyright: reportMissingImports=false

from __future__ import annotations

import argparse
import shutil
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
    get_account_id_argument,
    is_managed_record,
    require_api_token,
    run_main,
    summarize_dns_record,
    summarize_domain,
    summarize_project,
    summarize_zone,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Remove resources previously created by the static-deploy workflow.")
    parser.add_argument("--fqdn", required=True, help="Full hostname to remove, such as demo.tomasmota.dev")
    parser.add_argument("--project-name", required=True, help="Cloudflare Pages project name")
    parser.add_argument("--zone", default=DEFAULT_ZONE_NAME, help="Cloudflare zone name")
    parser.add_argument("--account-id", help="Cloudflare account ID")
    parser.add_argument("--local-dir", help="Local project directory to remove")
    parser.add_argument("--delete-local-dir", action="store_true", help="Delete the provided local project directory")
    parser.add_argument("--keep-dns", action="store_true", help="Keep the managed DNS record in place")
    parser.add_argument("--keep-domain", action="store_true", help="Keep the Pages custom domain attachment in place")
    parser.add_argument("--keep-project", action="store_true", help="Keep the Pages project in place")
    parser.add_argument("--apply", action="store_true", help="Execute deletion instead of returning a dry-run plan")
    return parser.parse_args()


def safe_local_dir(path_value: str, project_name: str) -> Path:
    path = Path(path_value).expanduser().resolve()
    if not path.exists():
        fail(
            "local_dir_missing",
            f"Local project directory does not exist: {path}",
            details={"local_dir": str(path)},
        )
    if not path.is_dir():
        fail(
            "local_dir_not_directory",
            f"Local path is not a directory: {path}",
            details={"local_dir": str(path)},
        )
    if path in {Path("/").resolve(), Path.home().resolve()}:
        fail(
            "unsafe_local_dir",
            f"Refusing to remove unsafe directory target: {path}",
            details={"local_dir": str(path)},
        )
    if path.name != project_name:
        fail(
            "unexpected_local_dir",
            f"Local directory name does not match project name {project_name}.",
            details={"local_dir": str(path), "project_name": project_name},
        )
    return path


def build_plan(args: argparse.Namespace, client: CloudflareClient) -> dict:
    zone = client.get_zone(args.zone)
    account_id = client.resolve_account_id(zone, get_account_id_argument(args.account_id))
    project = client.get_pages_project(account_id, args.project_name)
    dns_records = client.list_dns_records(zone["id"], args.fqdn)
    attached_domain = client.get_project_domain(account_id, args.project_name, args.fqdn) if project else None

    foreign_domain_matches = []
    if project is None or attached_domain is None:
        matches = client.find_domain_attachments(account_id, args.fqdn)
        foreign_domain_matches = [match for match in matches if match["project"] != args.project_name]

    managed_dns_records = [record for record in dns_records if is_managed_record(record, args.project_name)]
    conflicting_dns_records = [record for record in dns_records if record not in managed_dns_records]

    local_dir = None
    if args.local_dir:
        local_dir = safe_local_dir(args.local_dir, args.project_name)

    actions = []
    if args.keep_dns:
        actions.append({"resource": "dns_record", "action": "skip", "reason": "keep-dns requested"})
    elif not dns_records:
        actions.append({"resource": "dns_record", "action": "none", "reason": "no matching dns record found"})
    elif managed_dns_records:
        for record in managed_dns_records:
            actions.append({
                "resource": "dns_record",
                "action": "delete",
                "record": summarize_dns_record(record),
                "safe": True,
            })
    else:
        actions.append({
            "resource": "dns_record",
            "action": "skip",
            "reason": "matching dns record exists but is not marked as managed by static-deploy",
            "records": [summarize_dns_record(record) for record in conflicting_dns_records],
        })

    if args.keep_domain:
        actions.append({"resource": "pages_domain", "action": "skip", "reason": "keep-domain requested"})
    elif attached_domain is not None:
        actions.append({
            "resource": "pages_domain",
            "action": "delete",
            "domain": summarize_domain(attached_domain),
            "safe": True,
        })
    elif foreign_domain_matches:
        actions.append({
            "resource": "pages_domain",
            "action": "skip",
            "reason": "custom domain is attached to a different Pages project",
            "matches": foreign_domain_matches,
        })
    else:
        actions.append({"resource": "pages_domain", "action": "none", "reason": "no domain attachment found on target project"})

    if args.keep_project:
        actions.append({"resource": "pages_project", "action": "skip", "reason": "keep-project requested"})
    elif project is not None:
        actions.append({
            "resource": "pages_project",
            "action": "delete",
            "project": summarize_project(project),
            "safe": True,
        })
    else:
        actions.append({"resource": "pages_project", "action": "none", "reason": "project not found"})

    if args.delete_local_dir:
        if local_dir is None:
            fail(
                "missing_local_dir",
                "--delete-local-dir requires --local-dir.",
                details={"project_name": args.project_name},
            )
        actions.append({
            "resource": "local_dir",
            "action": "delete",
            "path": str(local_dir),
            "safe": True,
        })
    elif args.local_dir:
        actions.append({"resource": "local_dir", "action": "skip", "reason": "local directory provided but delete-local-dir not requested", "path": str(local_dir)})

    return {
        "zone": summarize_zone(zone),
        "account_id": account_id,
        "project_exists": project is not None,
        "project": summarize_project(project) if project else None,
        "foreign_domain_matches": foreign_domain_matches,
        "dns_records": [summarize_dns_record(record) for record in dns_records],
        "actions": actions,
    }


def apply_plan(args: argparse.Namespace, client: CloudflareClient, plan: dict) -> list[dict]:
    account_id = plan["account_id"]
    zone_id = plan["zone"]["id"]
    results = []

    for action in plan["actions"]:
        resource = action["resource"]
        decision = action["action"]
        if decision != "delete":
            results.append({"resource": resource, "status": decision, "details": action})
            continue

        if resource == "dns_record":
            record = action["record"]
            client.delete_dns_record(zone_id, record["id"])
            results.append({"resource": resource, "status": "deleted", "record": record})
        elif resource == "pages_domain":
            domain = action["domain"]
            deleted = client.delete_project_domain(account_id, args.project_name, domain["name"])
            results.append({"resource": resource, "status": "deleted" if deleted else "missing", "domain": domain})
        elif resource == "pages_project":
            project = action["project"]
            deleted = client.delete_pages_project(account_id, args.project_name)
            results.append({"resource": resource, "status": "deleted" if deleted else "missing", "project": project})
        elif resource == "local_dir":
            path = Path(action["path"])
            shutil.rmtree(path)
            results.append({"resource": resource, "status": "deleted", "path": str(path)})
        else:
            fail(
                "unknown_cleanup_action",
                f"Unknown cleanup action for resource {resource}.",
                details={"action": action},
            )

    return results


def main() -> dict:
    args = parse_args()
    token = require_api_token()
    client = CloudflareClient(token)
    plan = build_plan(args, client)

    if not args.apply:
        return {
            "ok": True,
            "mode": "dry-run",
            **plan,
        }

    results = apply_plan(args, client, plan)
    return {
        "ok": True,
        "mode": "apply",
        **plan,
        "results": results,
    }


if __name__ == "__main__":
    run_main(main)
