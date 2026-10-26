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

import html
import re
import shutil
import webbrowser
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from tern_sdk import ui

from ternui import Board, command_json

LIST = "merge_requests"
PER_PAGE = 50
TICKET = re.compile(r"\b([A-Z][A-Z0-9]{1,9}-\d+)\b")
# Jira links GitLab renders from ticket keys (its Jira integration), so no site URL lives here.
JIRA_LINK = re.compile(r'href="(https?://[^"]*/browse/([A-Z][A-Z0-9]{1,9}-\d+)[^"]*)"')
ACTIVE = {"running", "pending", "created", "scheduled", "preparing", "waiting_for_resource"}
ACTIVE_POLL, IDLE_POLL = 15.0, 120.0
FAILED = {"failed", "canceled"}
HARD_MERGE = {"conflict", "requested_changes"}
STATE_WIDTH = {"w": "10ch"}
BUCKETS = (("blocked", "needs attention", "warning"), ("ready", "ready", "success"),
           ("waiting", "waiting", "pending"), ("unknown", "unknown", "warning"))


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
        "conflicts": None, "threads": None, "error": error, "tickets": {},
    }


def _item(row: dict[str, Any]) -> dict[str, Any]:
    item = _blank(row)
    pid, iid = row["project_id"], row["iid"]
    try:
        detail = glab(f"projects/{pid}/merge_requests/{iid}?render_html=true")
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
    tickets: dict[str, str] = {}  # title links first, then description links
    for field in ("title_html", "description_html"):
        for url, key in JIRA_LINK.findall(str(detail.get(field) or "")):
            tickets.setdefault(key, html.unescape(url))
    item["tickets"] = tickets
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


def _ticket_link(item: dict[str, Any]) -> tuple[str, str] | None:
    """The MR's ticket and its Jira URL: the title's ticket, else the description's first."""
    tickets = item.get("tickets") or {}
    key = _ticket(item["title"])
    if key:
        return (key, tickets[key]) if key in tickets else None
    return next(iter(tickets.items()), None)


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


def _ci(item: dict[str, Any]) -> str:
    pipe = (item["pipeline"] or "").lower()
    return "CI passed" if pipe == "success" else f"CI {pipe}"


def _reasons(item: dict[str, Any]) -> list[tuple[str, str]]:
    """Specific blockers, most serious first, each with a span tone."""
    if item["error"]:
        return [("detail failed", "error")]
    reasons: list[tuple[str, str]] = []
    pipe = (item["pipeline"] or "").lower()
    if item["draft"]:
        reasons.append(("draft", "muted"))
    if not pipe:
        reasons.append(("pipeline unknown", "warning"))
    elif pipe in FAILED:
        reasons.append((_ci(item), "error"))
    elif pipe in ACTIVE:
        reasons.append((_ci(item), "info"))
    if item["conflicts"] is not False:
        reasons.append(("conflicts" if item["conflicts"] else "conflicts unknown",
                        "error" if item["conflicts"] else "warning"))
    if item["threads"] is not True:
        reasons.append(("threads unknown" if item["threads"] is None else "threads open",
                        "warning"))
    have, need = item["approvals"], item["required"]
    if have is None:
        reasons.append(("approvals unknown", "warning"))
    elif need is None:
        reasons.append(("required approvals unknown", "warning"))
    elif have < need:
        short = need - have
        reasons.append((f"{short} approval{'s' if short > 1 else ''} needed", "warning"))
    if item["state"] != "opened":
        reasons.append((f"state {item['state']}", "warning"))
    if item["merge"] in {"checking", "approvals_syncing"}:
        reasons.append((item["merge"].replace("_", " "), "info"))
    elif not reasons and item["merge"] != "mergeable":
        reasons.append(("merge status unknown" if item["merge"] == "unknown"
                        else item["merge"].replace("_", " "), "warning"))
    return reasons


def _state(item: dict[str, Any]) -> tuple[str, str, str]:
    """Bucket, row label and tone: ready, blocked, waiting or unknown."""
    if not blockers(item):
        return "ready", "ready", "success"
    pipe = (item["pipeline"] or "").lower()
    if (pipe in FAILED or item["conflicts"] is True or item["threads"] is False
            or item["merge"] in HARD_MERGE or item["state"] != "opened"):
        tone = "error" if pipe in FAILED or item["conflicts"] is True else "warning"
        return "blocked", "blocked", tone
    if (item["error"] or not item["pipeline"] or item["merge"] == "unknown"
            or item["approvals"] is None or item["required"] is None
            or item["conflicts"] is None or item["threads"] is None or not item["sha"]):
        return "unknown", "unknown", "warning"
    return "waiting", "waiting", "pending"


def _state_node(item: dict[str, Any]) -> ui.Node:
    bucket, label, tone = _state(item)
    if bucket == "ready":  # all clear: quiet text, not another filled badge
        inner = ui.row(ui.icon("check", tone="success"),
                       ui.text(label, tone="success"), gap="xs")
    else:
        inner = ui.badge(label, tone=tone)
    return ui.row(inner, min=STATE_WIDTH)


def _meta(item: dict[str, Any], key: str) -> ui.Node:
    reasons = _reasons(item)
    done = {text for text, _ in reasons}
    spans: list[ui.Span] = []

    def add(text: str, style: str | None = None, href: str | None = None) -> None:
        if spans:
            spans.append(ui.span(" · ", "dim"))
        spans.append(ui.span(text, style, href=href or None))

    ci = _ci(item) if item["pipeline"] else None
    for text, tone in reasons:  # blockers lead, and bold; a CI blocker links its pipeline
        add(text, f"strong {tone}" if tone in {"error", "warning"} else tone,
            item["pipeline_url"] if text == ci else None)
    if item["iid"]:  # links draw in link color; muted would hide them
        add(f"!{item['iid']}", None if item["url"] else "muted", item["url"])
    ticket = _ticket_link(item)
    if ticket and not _ticket(item["title"]):  # a title ticket is linked in the card head
        add(ticket[0], None, ticket[1])
    if item["branch"]:
        add(item["branch"], "muted")
    if ci and ci not in done:
        add(ci, None if item["pipeline_url"] else "muted", item["pipeline_url"])
    if item["approvals"] is not None and item["required"] is not None:
        add(f"{item['approvals']}/{item['required']} approvals", "muted")
    if not reasons and item["sha"]:  # the exact revision a merge would be pinned to
        add(item["sha"][:8], "dim")
    return ui.text(spans, wrap="word", key=key)


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
    entries: dict[str, Any] = {}
    if board.agent_session:  # only an agent that opened the board can wait for asks
        entries["Ask agent"] = lambda _event=None: _ask(board, item)
    if item["url"]:
        entries["Open MR"] = lambda _event=None: _open(board, item["url"])
    ticket = _ticket_link(item)
    if ticket:
        entries["Open ticket"] = lambda _event=None: _open(board, ticket[1])
    if item["pipeline_url"]:
        entries["Open pipeline"] = lambda _event=None: _open(board, item["pipeline_url"])
    if item["branch"]:
        entries["Copy branch"] = lambda _event=None: _copy(board, item["branch"])
    if not board.fixture and not blockers(item):
        entries["Merge (confirm)"] = lambda _event=None: _merge(board, item)
    return entries


def _row(board: Board, item: dict[str, Any], group: str) -> ui.Node:
    ref = item["ref"]
    title = item["title"]
    if group == _ticket(title) and title.upper().startswith(f"{group}:"):
        title = title[len(group) + 1:].lstrip()  # the card head already names the ticket
    return ui.col(  # a plain click anywhere on the row opens the MR in Tern's link handling
        ui.row(_state_node(item),
               ui.text(title, grow=1, truncate="end", key=f"title:{ref}"),
               gap="sm", align="center", key=f"head:{ref}"),
        _meta(item, f"meta:{ref}"),
        gap="xs", key=f"mr:{ref}", title=item["approval_error"] or item["error"] or None,
        href=item["url"] or None, actions={"click": "open"} if item["url"] else None,
        on_menu=_menu(board, item),
    )


def _summary(items: list[dict[str, Any]]) -> ui.Node:
    counts = Counter(_state(item)[0] for item in items)
    spans: list[ui.Span] = []
    for bucket, label, tone in BUCKETS:
        if not counts[bucket]:
            continue
        if spans:
            spans.append(ui.span(" · ", "dim"))
        if bucket == "blocked" and counts[bucket] > 1:
            label = "need attention"
        spans.append(ui.span(f"{counts[bucket]} {label}", tone))
    return ui.text(spans, wrap="word", key="summary")


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
        head = f"{label} · {len(group)} MR{'s' if len(group) > 1 else ''}"
        url = next((link[1] for item in group
                    if (link := _ticket_link(item)) and link[0] == key), None)
        cards.append(ui.card(*(_row(board, item, key) for item in group),
                             head=[ui.span(key, href=url), head[len(key):]] if url else head,
                             key=f"group:{key}"))

    empty = ui.card(ui.text("No open merge requests.", key="empty-text"),
                    ui.text("Nothing authored by you is open now. Press r to check again.",
                            tone="muted", wrap="word"), head="All clear", key="empty")
    hint = ("Click a row to open its MR; ⌘-click a link to open it. Row menu: open MR, ticket "
            "or pipeline, copy branch" + (", ask agent" if board.agent_session else "")
            + ". Merge appears only when every check is known good; it confirms first.")
    return ui.col(
        ui.row(
            ui.text("My open merge requests", key="h-title"),
            ui.text(f"{len(items)} open", tone="muted", key="h-count"),
            gap="sm", wrap=True, key="header",
        ),
        _summary(items) if items else None,
        *(cards or [empty]),
        ui.text(f"Up to {PER_PAGE} most recently updated MRs. {hint}",
                tone="muted", wrap="word", key="hint"),
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
