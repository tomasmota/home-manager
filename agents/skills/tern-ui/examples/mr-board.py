#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tern-sdk==0.1.0"]
# ///
"""Open authored MRs grouped by ticket, from read-only `glab api --method GET`.

One failed detail call keeps its list row and shows the error. Merge is offered
only when every safety signal is known good, pinned to the fetched head SHA,
and confirmed by the kit. `--fixture` shows sample data; commands stay blocked.
"""

from __future__ import annotations

import re
import shutil
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from tern_sdk import ui

from ternui import Board, command_json

LIST = "merge_requests"
PER_PAGE = 50
TICKET = re.compile(r"\b([A-Z][A-Z0-9]{1,9}-\d+)\b")
ACTIVE = {"running", "pending", "created", "scheduled", "preparing", "waiting_for_resource"}
ACTIVE_POLL, IDLE_POLL = 15.0, 120.0
PIPE_TONE = {
    "success": "success", "failed": "error", "running": "info", "pending": "pending",
    "created": "pending", "manual": "muted", "skipped": "muted", "canceled": "muted",
}
MERGE_TONE = {
    "mergeable": "success", "not_approved": "warning", "approvals_syncing": "info",
    "ci_must_pass": "info", "ci_still_running": "info", "discussions_not_resolved": "warning",
    "draft": "muted", "conflict": "error", "requested_changes": "error", "checking": "pending",
}


def glab(path: str) -> Any:
    exe = shutil.which("glab")
    if exe is None:
        raise RuntimeError("glab not found on PATH")
    try:
        return command_json([exe, "api", "--method", "GET", path], timeout=90)
    except Exception as exc:
        raise RuntimeError(f"GET {path}: {exc}") from exc


def list_rows() -> list[dict[str, Any]]:
    batch = glab(
        f"{LIST}?state=opened&scope=created_by_me&order_by=updated_at&sort=desc"
        f"&per_page={PER_PAGE}"
    )
    if not isinstance(batch, list):
        raise RuntimeError("unexpected merge_requests payload")
    return [row for row in batch if isinstance(row, dict)]


def _blank(row: dict[str, Any], error: str | None = None) -> dict[str, Any]:
    refs = row.get("references")
    full = refs.get("full") if isinstance(refs, dict) else None
    return {
        "ref": str(full or f"!{row.get('iid', '?')}"), "iid": row.get("iid"),
        "title": str(row.get("title") or ""), "branch": str(row.get("source_branch") or ""),
        "url": str(row.get("web_url") or ""), "state": str(row.get("state") or "unknown"),
        "draft": bool(row.get("draft") or row.get("work_in_progress")),
        "pipeline": None, "pipeline_url": None, "merge": "unknown", "sha": None,
        "approvals": None, "required": None, "approval_error": None,
        "conflicts": None, "threads": None, "error": error,
    }


def _item(row: dict[str, Any]) -> dict[str, Any]:
    item = _blank(row)
    pid, iid = row["project_id"], row["iid"]
    try:
        detail = glab(f"projects/{pid}/merge_requests/{iid}")
        if not isinstance(detail, dict):
            raise RuntimeError("unexpected merge request payload")
    except Exception as exc:
        item["error"] = item["approval_error"] = str(exc)
        return item

    refs = detail.get("references")
    if isinstance(refs, dict) and refs.get("full"):
        item["ref"] = str(refs["full"])
    pipe = detail.get("head_pipeline") if isinstance(detail.get("head_pipeline"), dict) else {}
    diff = detail.get("diff_refs") if isinstance(detail.get("diff_refs"), dict) else {}
    item.update(
        title=str(detail.get("title") or item["title"]),
        branch=str(detail.get("source_branch") or item["branch"]),
        url=str(detail.get("web_url") or item["url"]),
        state=str(detail.get("state") or item["state"]),
        draft=bool(detail.get("draft") or detail.get("work_in_progress")),
        pipeline=pipe.get("status"),
        pipeline_url=pipe.get("web_url"),
        merge=detail.get("detailed_merge_status") or detail.get("merge_status") or "unknown",
        sha=detail.get("sha") or diff.get("head_sha"),
        conflicts=detail.get("has_conflicts"),
        threads=detail.get("blocking_discussions_resolved"),
    )
    try:
        data = glab(f"projects/{pid}/merge_requests/{iid}/approvals")
        if not isinstance(data, dict) or not isinstance(data.get("approved_by"), list):
            raise RuntimeError("unexpected approvals payload")
        required = data.get("approvals_required")
        if isinstance(required, bool) or not isinstance(required, (int, float)):
            raise RuntimeError("approvals_required missing")
        item.update(approvals=len(data["approved_by"]), required=int(required))
    except Exception as exc:
        item["approval_error"] = str(exc)
    return item


def fetch() -> dict[str, Any]:
    found: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=6) as pool:
        jobs = [(pool.submit(_item, row), row) for row in list_rows()]
        for job, row in jobs:
            try:
                found.append(job.result())
            except Exception as exc:
                found.append(_blank(row, str(exc)))
    found.sort(key=lambda item: item["ref"])
    return {"mrs": found}


def _ticket(title: str) -> str | None:
    found = TICKET.search(title)
    return found.group(1) if found else None


def _repo(item: dict[str, Any]) -> str:
    return item["ref"].split("!", 1)[0] or "unknown"


def _project(item: dict[str, Any]) -> str:
    return _repo(item).rsplit("/", 1)[-1] or "unknown"


def blockers(item: dict[str, Any]) -> list[str]:
    """Every reason a direct merge is unsafe or unknown."""
    pipe = (item["pipeline"] or "").lower()
    bad: list[str] = []
    if item["error"]: bad.append("detail unavailable")
    if item["state"] != "opened": bad.append(f"state {item['state']}")
    if item["draft"]: bad.append("draft")
    if not item["iid"]: bad.append("IID unknown")
    if not item["sha"]: bad.append("head SHA unknown")
    if item["conflicts"] is not False:
        bad.append("conflict state unknown" if item["conflicts"] is None else "conflicts")
    if item["threads"] is not True:
        bad.append("threads unknown" if item["threads"] is None else "threads unresolved")
    if pipe not in {"success", "skipped"}: bad.append(f"pipeline {pipe or 'unknown'}")
    if item["merge"] != "mergeable": bad.append(f"merge status {item['merge'] or 'unknown'}")
    if item["approvals"] is None: bad.append("approvals unknown")
    elif item["required"] is None: bad.append("required approvals unknown")
    elif item["approvals"] < item["required"]:
        bad.append(f"approvals {item['approvals']}/{item['required']}")
    return bad


def changes(old: Any, new: Any) -> list[dict[str, Any]]:
    if not isinstance(old, dict) or not isinstance(new, dict):
        return []
    def by_ref(rows: Any) -> dict[str, dict[str, Any]]:
        return {row["ref"]: row for row in rows or []
                if isinstance(row, dict) and row.get("ref")}

    before, after = by_ref(old.get("mrs")), by_ref(new.get("mrs"))
    events = [{"text": f"New MR {ref}", "ref": ref} for ref in sorted(after.keys() - before.keys())]
    for ref, item in after.items():
        previous = before.get(ref)
        if previous is None:
            continue
        if (previous["pipeline"], previous["merge"], previous["state"]) != (
                item["pipeline"], item["merge"], item["state"]):
            events.append({"text": f"{ref} pipeline or merge state changed", "ref": ref})
    events += [{"text": f"{ref} left the open list (state not checked)",
                "ref": ref, "kind": "disappeared"}
               for ref in sorted(before.keys() - after.keys())]
    return events


def _approvals(item: dict[str, Any], key: str) -> ui.Node:
    approved, required = item["approvals"], item["required"]
    if approved is None:
        return ui.badge("approvals unknown", tone="muted",
                        title=item["approval_error"] or "approvals unavailable", key=key)
    text = f"{approved}/{required}" if required is not None else f"{approved} approved"
    tone = ("success" if approved >= required else "warning") if required is not None else "muted"
    return ui.badge(text, tone=tone, key=key)


def _open(board: Board, url: str) -> None:
    try:
        if not webbrowser.open(url):
            raise RuntimeError("no browser handler")
        board.notify("Opened", sub=url)
    except Exception as exc:
        board.notify("Could not open link", sub=str(exc), tone="error")


def _copy(board: Board, branch: str) -> None:
    try:
        board.copy(branch)
    except Exception as exc:
        board.notify("Copy failed", sub=str(exc), tone="error")


def _ask(board: Board, item: dict[str, Any]) -> None:
    threads = "unknown" if item["threads"] is None else (
        "resolved" if item["threads"] else "unresolved")
    approvals = "unknown" if item["approvals"] is None or item["required"] is None else (
        f"{item['approvals']}/{item['required']}")
    board.ask(
        f"Review {item['ref']} ({item['title']}). Pipeline: {item['pipeline'] or 'none'}; "
        f"merge status: {item['merge']}; approvals: {approvals}; blocking threads: {threads}; "
        f"head SHA: {item['sha'] or 'unknown'}. What still blocks merge?",
        ref=item["ref"], branch=item["branch"], sha=item["sha"],
        pipeline=item["pipeline"], merge_status=item["merge"], blockers=blockers(item),
    )


def _merge(board: Board, item: dict[str, Any]) -> None:
    bad = blockers(item)
    if bad:
        board.notify("Not safe to merge", sub="; ".join(bad), tone="warning")
        return
    argv = ["glab", "mr", "merge", str(item["iid"]), "--repo", _repo(item),
            "--sha", item["sha"], "--auto-merge=false", "--yes"]
    board.command(f"Merge {item['ref']} at {item['sha'][:8]}", argv)


def _menu(board: Board, item: dict[str, Any]) -> dict[str, Any]:
    entries: dict[str, Any] = {"Ask agent": lambda _event=None: _ask(board, item)}
    if item["url"]:
        entries["Open MR"] = lambda _event=None: _open(board, item["url"])
    if item["pipeline_url"]:
        entries["Open pipeline"] = lambda _event=None: _open(board, item["pipeline_url"])
    if item["branch"]:
        entries["Copy branch"] = lambda _event=None: _copy(board, item["branch"])
    if not board.fixture and not blockers(item):
        entries["Merge (confirm)"] = lambda _event=None: _merge(board, item)
    return entries


def _row(board: Board, item: dict[str, Any]) -> ui.Node:
    ref = item["ref"]
    pipe = item["pipeline"] or ""
    thread = ("threads unknown", "muted") if item["threads"] is None else (
        ("threads resolved", "success") if item["threads"] else ("threads open", "warning"))
    bits: list[ui.Node] = [
        ui.text(ref, href=item["url"] or None, tone="accent", key=f"ref:{ref}"),
        ui.text(item["title"], grow=1, truncate="end", key=f"title:{ref}"),
        ui.badge(pipe or "no CI", tone=PIPE_TONE.get(pipe, "muted"),
                 href=item["pipeline_url"] or None, key=f"ci:{ref}"),
        ui.badge((item["merge"] or "unknown").replace("_", " "),
                 tone=MERGE_TONE.get(item["merge"], "neutral"), key=f"st:{ref}"),
        _approvals(item, f"ap:{ref}"),
        ui.badge(thread[0], tone=thread[1], key=f"th:{ref}"),
    ]
    if item["conflicts"]:
        bits.append(ui.badge("conflicts", tone="error", key=f"cf:{ref}"))
    if item["error"]:
        bits.append(ui.badge("detail failed", tone="error", title=item["error"], key=f"de:{ref}"))
    return ui.row(*bits, gap="sm", align="center", wrap=True, key=f"mr:{ref}",
                  on_menu=_menu(board, item))


def view(board: Board) -> ui.Node:
    data = board.data if isinstance(board.data, dict) else {}
    items = [item for item in data.get("mrs") or [] if isinstance(item, dict)]
    groups: dict[str, list[dict[str, Any]]] = {}
    for item in items:
        groups.setdefault(_ticket(item["title"]) or _project(item), []).append(item)

    cards: list[ui.Node] = []
    for key in sorted(groups):
        group = groups[key]
        projects = sorted({_project(item) for item in group})
        label = key if projects == [key] else f"{key} · {', '.join(projects)}"
        cards.append(ui.card(*(_row(board, item) for item in group),
                             head=f"{label} · {len(group)} MR", key=f"group:{key}"))

    return ui.col(
        ui.row(
            ui.text("My open merge requests", key="h-title"),
            ui.text(f"{len(items)} open", tone="muted"),
            gap="sm", wrap=True, key="header",
        ),
        *(cards or [ui.card(ui.text("No open merge requests.", key="empty-text"), key="empty")]),
        ui.text(f"Showing up to {PER_PAGE} most recently updated open MRs. "
                "Links open the MR and pipeline. Row menu: copy branch, ask agent. "
                "Merge appears only when every safety check is known good; it confirms first.",
                tone="muted", key="hint"),
        gap="md", key="root",
    )


def every(data: Any) -> float:
    items = data.get("mrs") or [] if isinstance(data, dict) else []
    active = any(
        (item.get("pipeline") or "").lower() in ACTIVE
        or item.get("merge") in {"checking", "approvals_syncing"}
        for item in items if isinstance(item, dict)
    )
    return ACTIVE_POLL if active else IDLE_POLL


BOARD = Board("Open merge requests", fetch=fetch, view=view, every=every, changes=changes)

if __name__ == "__main__":
    raise SystemExit(BOARD.run())
