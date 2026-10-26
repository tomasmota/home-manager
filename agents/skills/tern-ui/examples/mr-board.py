#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tern-sdk==0.1.0"]
# ///
"""Open authored MRs grouped by ticket, from read-only `glab api --method GET`.

A ticket in the MR title (never the description) makes the card: the head names the
key, each row is one MR. An MR with no ticket leads its own card, headed `repo!iid`.
One failed detail call keeps its list row and shows the error. Merge is offered
only when every safety signal is known good, pinned to the fetched head SHA,
and confirmed by the kit. Ticket titles are read through the Atlassian MCP
server with omp's existing sign-in; without it, cards show bare ticket keys.
`--fixture` shows sample data; commands stay blocked.
"""

from __future__ import annotations

import html
import json
import re
import shutil
import sqlite3
import time
import urllib.request
import webbrowser
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

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
BUCKETS = (("blocked", "needs attention", "warning"), ("ready", "ready", "success"),
           ("waiting", "waiting", "pending"), ("unknown", "unknown", "warning"))
RANK = {bucket: rank for rank, (bucket, _, _) in enumerate(BUCKETS)}  # card and row order
# omp keeps its Atlassian MCP OAuth sign-in here. The board only reads the access
# token and never refreshes it: omp owns the rotating refresh token, so titles pause
# once the token expires until omp next uses an Atlassian tool.
ATLASSIAN_MCP = "https://mcp.atlassian.com/v2/mcp"
OMP_AUTH_DB = Path.home() / ".omp" / "agent" / "agent.db"
TITLE_TTL = 3600.0
_titles: dict[str, tuple[str | None, float]] = {}  # key -> (summary, monotonic fetch time)


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
        "updated": str(row.get("updated_at") or ""),
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
        updated=str(detail.get("updated_at") or item["updated"]),
        pipeline=pipe.get("status"),
        pipeline_url=pipe.get("web_url"),
        merge=detail.get("detailed_merge_status") or detail.get("merge_status") or "unknown",
        sha=detail.get("sha") or diff.get("head_sha"),
        conflicts=detail.get("has_conflicts"),
        threads=detail.get("blocking_discussions_resolved"),
    )
    # Only the title names the MR's ticket: GitLab's Jira integration also links
    # key-shaped prose in descriptions, such as the ACME challenge type DNS-01.
    tickets: dict[str, str] = {}
    for url, key in JIRA_LINK.findall(str(detail.get("title_html") or "")):
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


def _mcp_token() -> str:
    try:
        with closing(sqlite3.connect(f"{OMP_AUTH_DB.as_uri()}?mode=ro", uri=True, timeout=5)) as db:
            row = db.execute(
                "SELECT data FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL"
                " ORDER BY updated_at DESC LIMIT 1",
                (f"mcp_oauth:profile:default:{ATLASSIAN_MCP}",)).fetchone()
    except sqlite3.Error as exc:
        raise RuntimeError(f"omp sign-in unreadable ({exc})") from None
    data = json.loads(row[0]) if row else {}
    if not data.get("access"):
        raise RuntimeError("no Atlassian sign-in in omp")
    if float(data.get("expires") or 0) / 1000 < time.time() + 60:
        raise RuntimeError("omp's Atlassian sign-in expired; using any Atlassian tool in omp renews it")
    return str(data["access"])


def _mcp(token: str, body: dict[str, Any], session: str | None = None) -> tuple[Any, str | None]:
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json",
               "Accept": "application/json, text/event-stream"}
    if session:
        headers["Mcp-Session-Id"] = session
    request = urllib.request.Request(ATLASSIAN_MCP, data=json.dumps(body).encode(),
                                     headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=30) as response:
        text = response.read().decode()
        session = response.headers.get("Mcp-Session-Id") or session
    if "id" not in body:  # a notification has no reply
        return None, session
    # The reply is one server-sent event or plain JSON.
    payload = next((line[5:] for line in text.splitlines() if line.startswith("data:")), text)
    return json.loads(payload), session


def _jira_summaries(site: str, keys: list[str]) -> dict[str, str]:
    """Read-only JQL lookup; keys match TICKET, so they are safe inside the query."""
    token = _mcp_token()
    _, session = _mcp(token, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "tern-ui-mr-board", "version": "1"}}})
    if not session:
        raise RuntimeError("Atlassian MCP gave no session")
    _mcp(token, {"jsonrpc": "2.0", "method": "notifications/initialized"}, session)
    reply, _ = _mcp(token, {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
        "name": "searchJiraIssuesUsingJql", "arguments": {
            "cloudId": site, "jql": f"key in ({', '.join(keys)})", "fields": ["summary"],
            "maxResults": len(keys), "responseFields": ["issues.key", "issues.fields.summary"]}}},
        session)
    result = reply.get("result") if isinstance(reply, dict) else None
    content = (result or {}).get("content") or [{}]
    text = str(content[0].get("text") or "")
    if not result or result.get("isError"):
        error = (reply or {}).get("error") or {}
        raise RuntimeError(f"Jira lookup failed: {(text or error.get('message') or 'no result')[:200]}")
    issues = (json.loads(text).get("data") or {}).get("issues") or []
    return {str(issue["key"]): str(issue["fields"]["summary"]) for issue in issues
            if isinstance(issue, dict) and (issue.get("fields") or {}).get("summary")}


def _ticket_titles(items: list[dict[str, Any]]) -> tuple[dict[str, str], str | None]:
    """Cached ticket summaries; a failed lookup keeps earlier titles and is retried next fetch."""
    links = {link for item in items if (link := _ticket_link(item))}
    now = time.monotonic()
    sites: dict[str, list[str]] = {}
    for key, url in sorted(links):
        if now - _titles.get(key, (None, float("-inf")))[1] > TITLE_TTL:
            sites.setdefault(urlsplit(url).hostname or "", []).append(key)
    error = None
    for site, keys in sites.items():
        try:
            found = _jira_summaries(site, keys)
        except Exception as exc:
            error = str(exc)
            continue
        for key in keys:  # no title: unknown key or no access; retried after the TTL
            _titles[key] = (found.get(key), now)
    return {key: title for key, _ in links if (title := _titles.get(key, (None, 0.0))[0])}, error


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
    titles, title_error = _ticket_titles(found)
    return {"mrs": found, "titles": titles, "title_error": title_error}


def _ticket(title: str) -> str | None:
    found = TICKET.search(title)
    return found.group(1) if found else None


def _ticket_link(item: dict[str, Any]) -> tuple[str, str] | None:
    """The title's ticket and the Jira URL GitLab rendered for it, if any."""
    key = _ticket(item["title"])
    if not key:
        return None
    url = (item.get("tickets") or {}).get(key)
    return (key, url) if url else None


def _repo(item: dict[str, Any]) -> str:
    return item["ref"].split("!", 1)[0] or "unknown"


def _project(item: dict[str, Any]) -> str:
    return _repo(item).rsplit("/", 1)[-1] or "unknown"


def _ref_text(item: dict[str, Any]) -> str | None:
    """`project !iid`, the reference this board shows; None until detail supplies the IID."""
    return f"{_project(item)} !{item['iid']}" if item["iid"] else None


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
    """Specific blockers, most serious first, each with a span tone. Every MR needs an
    approval, so a shortfall is no reason; the meta line marks approval once given."""
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
    if item["state"] != "opened":
        reasons.append((f"state {item['state']}", "warning"))
    if item["merge"] in {"checking", "approvals_syncing"}:
        reasons.append((item["merge"].replace("_", " "), "info"))
    elif not reasons and item["merge"] != "mergeable" and not (
            item["merge"] == "not_approved" and have < need):
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


def _order(item: dict[str, Any]) -> tuple[int, float]:
    """Most urgent first, in the summary's bucket order, then most recently updated."""
    try:
        updated = datetime.fromisoformat(str(item.get("updated") or "")).timestamp()
    except ValueError:
        updated = 0.0
    return RANK[_state(item)[0]], -updated


def _state_node(item: dict[str, Any]) -> ui.Node:
    """Compact leading marker. Labels are one short word each, so badges line up by
    themselves; pinning a wider column would only add air between state and title."""
    bucket, label, tone = _state(item)
    if bucket == "ready":  # all clear: quiet text, not another filled badge
        return ui.row(ui.icon("check", tone="success"),
                      ui.text(label, tone="success"), gap="xs")
    return ui.badge(label, tone=tone)


def _meta(item: dict[str, Any], key: str) -> ui.Node:
    """Attention signals lead, then one fixed slot order: ref, branch, CI, approvals.
    CI keeps its slot even when it blocks, so the same fact never moves between rows.
    Slots are sibling nodes rather than spans of one text so the branch can carry an icon."""
    reasons = _reasons(item)
    ci = _ci(item) if item["pipeline"] else None
    ci_tone = next((tone for text, tone in reasons if text == ci), None)
    parts: list[ui.Node] = []

    def add(slot: str, text: str, style: str | None = None, href: str | None = None,
            icon: ui.IconName | None = None) -> None:
        if parts:
            parts.append(ui.text([ui.span("·", "dim")], key=f"sep:{slot}"))
        span = ui.span(text, style, href=href or None)
        parts.append(ui.row(ui.icon(icon, tone="muted"), ui.text([span], key="text"),
                            gap="xs", align="center", key=slot)
                     if icon else ui.text([span], key=slot))

    for index, (text, tone) in enumerate(reasons):
        if text != ci:  # a failing pipeline already reads in its own slot
            add(f"reason{index}", text, f"strong {tone}" if tone in {"error", "warning"} else tone)
    if ref := _ref_text(item):  # links draw in link color; muted would hide them
        add("ref", ref, None if item["url"] else "muted", item["url"])
    if item["branch"]:
        add("branch", item["branch"], "muted", icon="branch")
    if ci:
        style = f"strong {ci_tone}" if ci_tone in {"error", "warning"} else ci_tone or "muted"
        add("ci", ci, style, item["pipeline_url"])
    have, need = item["approvals"], item["required"]
    if have is not None and need is not None:  # every MR needs one, so only news shows
        if have and have >= need:
            add("approvals", "approved", "success")
        elif need > 1:  # a count only where one approval is not enough
            add("approvals", f"{have}/{need} approvals", "muted")
    if item["sha"] and not blockers(item):  # the exact revision a merge would be pinned to
        add("sha", item["sha"][:8], "dim")
    return ui.row(*parts, gap="xs", wrap=True, align="center", key=key)


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


def _clean_title(title: str, key: str) -> str:
    """Drop the ticket prefix a ticket card head already shows: `KEY:`, `[KEY]:` or `[KEY]`."""
    match = re.match(rf"^(?:\[{re.escape(key)}\]|{re.escape(key)}\b)[\s:\-\u2013\u2014]*",
                     title, re.IGNORECASE)
    rest = title[match.end():].strip() if match else ""
    return rest or title


def _row(board: Board, item: dict[str, Any], group: str) -> ui.Node:
    ref = item["ref"]
    title = item["title"]
    if group == _ticket(title):  # the card head already shows the key, bracket or colon form
        title = _clean_title(title, group)
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
    titles = data.get("titles") if isinstance(data.get("titles"), dict) else {}
    # A card groups MRs that share one decision: a ticket, or the single MR itself when
    # nothing ties it to a ticket. Repo is a data source, not a decision.
    groups: dict[str, list[dict[str, Any]]] = {}
    for item in items:
        groups.setdefault(_ticket(item["title"]) or item["ref"], []).append(item)

    cards: list[ui.Node] = []
    untitled = False
    # Most urgent card first: a card ranks by its most urgent, then newest, MR; rows likewise.
    ordered = {key: sorted(group, key=_order) for key, group in groups.items()}
    for key in sorted(ordered, key=lambda key: (_order(ordered[key][0]), key)):
        group = ordered[key]
        first = group[0]
        head: Any = None  # a ticketless card is one MR, whose details line names it
        if key == _ticket(first["title"]):  # ticket card: head names the ticket
            url = next((link[1] for item in group if (link := _ticket_link(item))), None)
            title = titles.get(key) if url else None
            untitled = untitled or bool(url and not title)
            rest = f" · {title}" if title else ""
            head = [ui.span(key, href=url), rest] if url else key + rest
        cards.append(ui.card(*(_row(board, item, key) for item in group),
                             head=head, key=f"group:{key}"))

    empty = ui.card(ui.text("No open merge requests.", key="empty-text"),
                    ui.text("Nothing authored by you is open now. Press r to check again.",
                            tone="muted", wrap="word"), head="All clear", key="empty")
    count = f"{len(items)}+" if len(items) >= PER_PAGE else str(len(items))  # the list is capped
    return ui.col(
        ui.row(
            ui.text("My open merge requests", key="h-title"),
            ui.text(count, tone="muted", key="h-count"),
            gap="sm", wrap=True, key="header",
        ),
        _summary(items) if items else None,
        *(cards or [empty]),
        ui.text(f"Ticket titles unavailable: {data['title_error']}", tone="muted", wrap="word",
                key="title-error") if untitled and data.get("title_error") else None,
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
