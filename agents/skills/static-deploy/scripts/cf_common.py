#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError

API_BASE_URL = os.environ.get("CLOUDFLARE_API_BASE_URL", "https://api.cloudflare.com/client/v4")
DEFAULT_ZONE_NAME = "tomasmota.dev"
DEFAULT_TIMEOUT_SECONDS = 30
MANAGED_COMMENT_PREFIX = "managed-by: static-deploy"
PROBE_RECORD_ID = "0" * 32
REQUIRED_PERMISSIONS = [
    "Cloudflare Pages Edit",
    "Zone Read",
    "DNS Edit",
]


@dataclass
class ScriptError(Exception):
    code: str
    message: str
    details: dict[str, Any] | None = None
    exit_code: int = 1
    status: int | None = None

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "ok": False,
            "error": {
                "code": self.code,
                "message": self.message,
            },
        }
        if self.status is not None:
            payload["error"]["status"] = self.status
        if self.details:
            payload["error"]["details"] = self.details
        return payload


def emit_json(payload: dict[str, Any]) -> None:
    json.dump(payload, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


def run_main(main: Any) -> None:
    try:
        payload = main()
    except ScriptError as exc:
        emit_json(exc.to_payload())
        raise SystemExit(exc.exit_code)
    except KeyboardInterrupt:
        emit_json(
            {
                "ok": False,
                "error": {
                    "code": "interrupted",
                    "message": "Operation interrupted.",
                },
            }
        )
        raise SystemExit(130)

    if payload is not None:
        emit_json(payload)


def fail(
    code: str,
    message: str,
    *,
    details: dict[str, Any] | None = None,
    exit_code: int = 1,
    status: int | None = None,
) -> None:
    raise ScriptError(code=code, message=message, details=details, exit_code=exit_code, status=status)


def require_api_token() -> str:
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if token:
        return token

    fail(
        "missing_env",
        "CLOUDFLARE_API_TOKEN is not set. This skill expects token-based auth rather than wrangler login.",
        details={
            "required_env": ["CLOUDFLARE_API_TOKEN"],
            "optional_env": ["CLOUDFLARE_ACCOUNT_ID"],
            "required_permissions": REQUIRED_PERMISSIONS,
            "zone": DEFAULT_ZONE_NAME,
            "wrangler_login_required": False,
        },
    )
    raise AssertionError("unreachable")


def get_account_id_argument(explicit_account_id: str | None) -> str | None:
    return explicit_account_id or os.environ.get("CLOUDFLARE_ACCOUNT_ID")


def managed_comment(project_name: str | None = None) -> str:
    if project_name:
        return f"{MANAGED_COMMENT_PREFIX}; project:{project_name}"
    return MANAGED_COMMENT_PREFIX


def is_managed_record(record: dict[str, Any], project_name: str | None = None) -> bool:
    comment = record.get("comment") or ""
    if MANAGED_COMMENT_PREFIX not in comment:
        return False
    if project_name is None:
        return True
    return f"project:{project_name}" in comment


def summarize_zone(zone: dict[str, Any]) -> dict[str, Any]:
    account = zone.get("account") or {}
    return {
        "id": zone.get("id"),
        "name": zone.get("name"),
        "status": zone.get("status"),
        "account_id": account.get("id"),
        "account_name": account.get("name"),
    }


def summarize_project(project: dict[str, Any]) -> dict[str, Any]:
    latest_deployment = project.get("latest_deployment") or {}
    return {
        "name": project.get("name"),
        "subdomain": project.get("subdomain"),
        "domains": project.get("domains") or [],
        "production_branch": project.get("production_branch"),
        "framework": project.get("framework"),
        "uses_functions": project.get("uses_functions"),
        "latest_deployment_url": latest_deployment.get("url"),
    }


def summarize_domain(domain: dict[str, Any]) -> dict[str, Any]:
    validation = domain.get("validation_data") or {}
    verification = domain.get("verification_data") or {}
    return {
        "name": domain.get("name"),
        "status": domain.get("status"),
        "certificate_authority": domain.get("certificate_authority"),
        "validation_status": validation.get("status"),
        "validation_method": validation.get("method"),
        "validation_error": validation.get("error_message"),
        "verification_status": verification.get("status"),
        "verification_error": verification.get("error_message"),
    }


def summarize_dns_record(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": record.get("id"),
        "type": record.get("type"),
        "name": record.get("name"),
        "content": record.get("content"),
        "proxied": record.get("proxied"),
        "ttl": record.get("ttl"),
        "comment": record.get("comment"),
    }


class CloudflareClient:
    def __init__(self, token: str) -> None:
        self.token = token

    def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        payload: dict[str, Any] | list[Any] | None = None,
        allow_statuses: tuple[int, ...] = (),
    ) -> tuple[int, dict[str, Any]]:
        url = API_BASE_URL + path
        if params:
            query = urllib.parse.urlencode(params, doseq=True)
            url = f"{url}?{query}"

        data: bytes | None = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
        elif method not in {"GET", "DELETE"}:
            data = b"{}"

        request = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "static-deploy-scripts/1.0",
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=DEFAULT_TIMEOUT_SECONDS) as response:
                text = response.read().decode("utf-8", errors="replace")
                parsed = parse_json_text(text)
                return response.status, parsed
        except HTTPError as exc:
            text = exc.read().decode("utf-8", errors="replace")
            parsed = parse_json_text(text)
            if exc.code in allow_statuses:
                return exc.code, parsed
            self.raise_api_error(exc.code, parsed, method, path)
        except URLError as exc:
            fail(
                "network_error",
                f"Cloudflare API request failed: {exc.reason}",
                details={"method": method, "path": path},
            )

        fail("unexpected_error", "Unexpected Cloudflare API control flow.")
        raise AssertionError("unreachable")

    def raise_api_error(self, status: int, payload: dict[str, Any], method: str, path: str) -> None:
        api_errors = payload.get("errors") or []
        api_messages = payload.get("messages") or []
        message = None
        if api_errors:
            message = api_errors[0].get("message")
        elif api_messages:
            message = api_messages[0].get("message")
        if not message:
            message = f"Cloudflare API returned HTTP {status}."

        code = "cloudflare_api_error"
        if status == 401:
            code = "authentication_failed"
        elif status == 403:
            code = "insufficient_permissions"
        elif status == 404:
            code = "not_found"
        elif status == 409:
            code = "conflict"

        fail(
            code,
            message,
            details={
                "status": status,
                "method": method,
                "path": path,
                "api_errors": api_errors,
                "api_messages": api_messages,
            },
            status=status,
        )

    def verify_token(self) -> dict[str, Any]:
        _, payload = self.request("GET", "/user/tokens/verify")
        return payload.get("result") or {}

    def get_zone(self, zone_name: str) -> dict[str, Any]:
        _, payload = self.request("GET", "/zones", params={"name": zone_name, "per_page": 20})
        zones = payload.get("result") or []
        matches = [zone for zone in zones if zone.get("name") == zone_name]
        if not matches:
            fail(
                "zone_not_found",
                f"The Cloudflare token cannot access the {zone_name} zone.",
                details={"zone": zone_name},
            )
        if len(matches) > 1:
            fail(
                "ambiguous_zone",
                f"Multiple Cloudflare zones matched {zone_name}; refusing to guess.",
                details={"zone": zone_name, "count": len(matches)},
            )
        return matches[0]

    def resolve_account_id(self, zone: dict[str, Any], explicit_account_id: str | None) -> str:
        zone_account_id = ((zone.get("account") or {}).get("id"))
        if explicit_account_id and zone_account_id and explicit_account_id != zone_account_id:
            fail(
                "account_mismatch",
                "CLOUDFLARE_ACCOUNT_ID does not match the account that owns the zone.",
                details={
                    "provided_account_id": explicit_account_id,
                    "zone_account_id": zone_account_id,
                    "zone": zone.get("name"),
                },
            )
        if explicit_account_id:
            return explicit_account_id
        if zone_account_id:
            return zone_account_id
        fail(
            "missing_account_id",
            "Could not determine the Cloudflare account ID from the zone lookup.",
            details={"zone": zone.get("name")},
        )
        raise AssertionError("unreachable")

    def list_pages_projects(self, account_id: str) -> list[dict[str, Any]]:
        _, payload = self.request("GET", f"/accounts/{account_id}/pages/projects")
        results = payload.get("result") or []
        result_info = payload.get("result_info") or {}
        total_pages = result_info.get("total_pages") or 1
        current_page = result_info.get("page") or 1

        if total_pages <= current_page:
            return results

        for page in range(current_page + 1, total_pages + 1):
            status, page_payload = self.request(
                "GET",
                f"/accounts/{account_id}/pages/projects",
                params={"page": page},
                allow_statuses=(400,),
            )
            if status == 400:
                fail(
                    "pages_pagination_failed",
                    "Cloudflare Pages project pagination failed while enumerating projects.",
                    details={
                        "account_id": account_id,
                        "requested_page": page,
                        "result_info": result_info,
                        "api_errors": page_payload.get("errors") or [],
                    },
                )
            results.extend(page_payload.get("result") or [])

        deduped: dict[str, dict[str, Any]] = {}
        for project in results:
            name = project.get("name")
            if name:
                deduped[name] = project
        return list(deduped.values())

    def get_pages_project(self, account_id: str, project_name: str) -> dict[str, Any] | None:
        status, payload = self.request(
            "GET",
            f"/accounts/{account_id}/pages/projects/{project_name}",
            allow_statuses=(404,),
        )
        if status == 404:
            return None
        return payload.get("result") or {}

    def ensure_pages_project(
        self,
        account_id: str,
        project_name: str,
        production_branch: str,
    ) -> tuple[bool, dict[str, Any]]:
        existing = self.get_pages_project(account_id, project_name)
        if existing is not None:
            return False, existing

        self.request(
            "POST",
            f"/accounts/{account_id}/pages/projects",
            payload={"name": project_name, "production_branch": production_branch},
        )
        created = self.get_pages_project(account_id, project_name)
        if created is None:
            fail(
                "project_create_failed",
                f"Cloudflare reported success creating {project_name}, but the project could not be fetched afterwards.",
                details={"project_name": project_name, "account_id": account_id},
            )
            raise AssertionError("unreachable")
        return True, created

    def list_project_domains(self, account_id: str, project_name: str) -> list[dict[str, Any]]:
        _, payload = self.request("GET", f"/accounts/{account_id}/pages/projects/{project_name}/domains")
        return payload.get("result") or []

    def get_project_domain(self, account_id: str, project_name: str, domain_name: str) -> dict[str, Any] | None:
        status, payload = self.request(
            "GET",
            f"/accounts/{account_id}/pages/projects/{project_name}/domains/{domain_name}",
            allow_statuses=(404,),
        )
        if status == 404:
            return None
        return payload.get("result") or {}

    def ensure_project_domain(self, account_id: str, project_name: str, domain_name: str) -> tuple[bool, dict[str, Any]]:
        existing = self.get_project_domain(account_id, project_name, domain_name)
        if existing is not None:
            return False, existing

        self.request(
            "POST",
            f"/accounts/{account_id}/pages/projects/{project_name}/domains",
            payload={"name": domain_name},
        )
        created = self.get_project_domain(account_id, project_name, domain_name)
        if created is None:
            fail(
                "domain_attach_failed",
                f"Cloudflare reported success attaching {domain_name}, but the domain could not be fetched afterwards.",
                details={"project_name": project_name, "domain": domain_name},
            )
            raise AssertionError("unreachable")
        return True, created

    def retry_project_domain_validation(self, account_id: str, project_name: str, domain_name: str) -> dict[str, Any]:
        _, payload = self.request(
            "PATCH",
            f"/accounts/{account_id}/pages/projects/{project_name}/domains/{domain_name}",
            payload={},
        )
        return payload.get("result") or {}

    def list_dns_records(self, zone_id: str, name: str) -> list[dict[str, Any]]:
        _, payload = self.request(
            "GET",
            f"/zones/{zone_id}/dns_records",
            params={"name": name, "per_page": 100},
        )
        return payload.get("result") or []

    def create_dns_record(self, zone_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        _, response_payload = self.request("POST", f"/zones/{zone_id}/dns_records", payload=payload)
        return response_payload.get("result") or {}

    def patch_dns_record(self, zone_id: str, record_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        _, response_payload = self.request(
            "PATCH",
            f"/zones/{zone_id}/dns_records/{record_id}",
            payload=payload,
        )
        return response_payload.get("result") or {}

    def delete_dns_record(self, zone_id: str, record_id: str) -> dict[str, Any] | None:
        status, response_payload = self.request(
            "DELETE",
            f"/zones/{zone_id}/dns_records/{record_id}",
            allow_statuses=(404,),
        )
        if status == 404:
            return None
        return response_payload.get("result") or {}

    def probe_dns_write_access(self, zone_id: str) -> dict[str, Any]:
        try:
            status, payload = self.request(
                "PATCH",
                f"/zones/{zone_id}/dns_records/{PROBE_RECORD_ID}",
                payload={},
                allow_statuses=(400, 404),
            )
        except ScriptError as exc:
            if exc.status == 403:
                fail(
                    "missing_dns_edit_permission",
                    "The Cloudflare token cannot edit DNS records for tomasmota.dev.",
                    details={
                        "required_env": ["CLOUDFLARE_API_TOKEN"],
                        "required_permissions": REQUIRED_PERMISSIONS,
                        "zone": DEFAULT_ZONE_NAME,
                    },
                    status=403,
                )
            raise

        return {
            "ok": True,
            "probe_status": status,
            "api_errors": payload.get("errors") or [],
        }

    def delete_project_domain(self, account_id: str, project_name: str, domain_name: str) -> bool:
        status, _ = self.request(
            "DELETE",
            f"/accounts/{account_id}/pages/projects/{project_name}/domains/{domain_name}",
            allow_statuses=(404,),
        )
        return status != 404

    def delete_pages_project(self, account_id: str, project_name: str) -> bool:
        status, _ = self.request(
            "DELETE",
            f"/accounts/{account_id}/pages/projects/{project_name}",
            allow_statuses=(404,),
        )
        return status != 404

    def find_domain_attachments(
        self,
        account_id: str,
        fqdn: str,
        projects: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        if projects is None:
            projects = self.list_pages_projects(account_id)

        matches: list[dict[str, Any]] = []
        for project in projects:
            project_name = project.get("name")
            if not project_name:
                continue
            for domain in self.list_project_domains(account_id, project_name):
                if domain.get("name") == fqdn:
                    matches.append(
                        {
                            "project": project_name,
                            "domain": summarize_domain(domain),
                        }
                    )
        return matches


def parse_json_text(text: str) -> dict[str, Any]:
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {"raw": text}
    if isinstance(parsed, dict):
        return parsed
    return {"result": parsed}
