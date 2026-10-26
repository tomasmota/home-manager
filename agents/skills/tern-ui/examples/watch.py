#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tern-sdk==0.1.0"]
# ///
"""Read-only watcher for a local job's JSON status.

The default command reads STATUS_PATH when it exists, otherwise it shows a
clearly labelled local demo driven by the clock. It never writes status and
never reports remote deployment data. `--fixture` is labelled by the kit.
"""

from __future__ import annotations

import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tern_sdk import ui

from ternui import Board, command_json

STATE_ROOT = Path(os.environ.get("XDG_STATE_HOME", "~/.local/state")).expanduser()
STATUS_PATH = Path(
    os.environ.get("TERN_WATCH_STATUS", str(STATE_ROOT / "tern-ui" / "watch-status.json"))
).expanduser()
STEP_SECONDS = 10
DEMO_STEPS = ("prepare", "build", "test", "package", "publish")
DONE_STATES = {"succeeded", "failed", "cancelled", "skipped"}
ACTIVE_POLL, IDLE_POLL = 4.0, 30.0

DEMO_STATUS = r'''
import json, sys, time
from datetime import datetime, timezone
from pathlib import Path

path, span, steps = Path(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
if path.is_file():
    try:
        raw = json.loads(path.read_text())
    except Exception as exc:
        raise SystemExit(f"cannot read {path}: {exc}")
    if not isinstance(raw, dict):
        raise SystemExit("status JSON must be an object")
    raw.setdefault("source", "file")
    raw.setdefault("job", path.stem)
    print(json.dumps(raw))
    raise SystemExit(0)

now = time.time()
cycle = span * (len(steps) + 1)
start = (int(now) // cycle) * cycle
index = min((int(now) - start) // span, len(steps))

def stamp(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

rows = []
for i, name in enumerate(steps):
    if i < index:
        state, at = "done", stamp(start + (i + 1) * span)
    elif i == index and index < len(steps):
        state, at = "running", stamp(start + i * span)
    else:
        state, at = "pending", ""
    rows.append({"name": name, "state": state, "detail": "", "at": at})

print(json.dumps({
    "job": "local-report-build",
    "source": "demo-clock",
    "state": "running" if index < len(steps) else "succeeded",
    "step": steps[index] if index < len(steps) else "complete",
    "progress": round(index / len(steps), 3),
    "updated_at": stamp(start + index * span),
    "steps": rows,
    "note": "Demo clock: local synthetic job, not deployment data. Edit STATUS_CMD/STATUS_PATH for a real status file.",
}))
'''

STATUS_CMD = [sys.executable, "-c", DEMO_STATUS, str(STATUS_PATH), str(STEP_SECONDS), *DEMO_STEPS]
STATE_TONE = {
    "pending": "pending", "queued": "pending", "running": "info", "succeeded": "success",
    "failed": "error", "cancelled": "muted", "skipped": "muted", "unknown": "muted",
}
CARD_STATUS = {
    "pending": "pending", "queued": "pending", "running": "running", "succeeded": "done",
    "failed": "error", "cancelled": "cancelled", "skipped": "done",
}
STEP = {
    "pending": ("clock", "muted"), "running": ("run", "info"), "done": ("check", "success"),
    "failed": ("x", "error"), "skipped": ("minus", "muted"), "cancelled": ("slash", "muted"),
}


def _text(value: Any, default: str = "") -> str:
    return value.strip() if isinstance(value, str) else default


def normalize(raw: dict[str, Any]) -> dict[str, Any]:
    state = _text(raw.get("state"), "unknown").lower()
    if state in {"success", "done", "complete"}:
        state = "succeeded"
    steps = []
    for entry in raw.get("steps") or []:
        if not isinstance(entry, dict) or not _text(entry.get("name")):
            continue
        step_state = _text(entry.get("state"), "pending").lower()
        if step_state in {"success", "complete"}:
            step_state = "done"
        steps.append({
            "name": _text(entry.get("name")), "state": step_state,
            "detail": _text(entry.get("detail")), "at": _text(entry.get("at")),
        })
    progress = raw.get("progress")
    if isinstance(progress, bool) or not isinstance(progress, (int, float)):
        done = sum(step["state"] in {"done", "skipped"} for step in steps)
        progress = done / len(steps) if steps else 0.0
    if state == "succeeded":
        progress = 1.0
    return {
        "job": _text(raw.get("job"), "local-job"),
        "source": _text(raw.get("source"), "unknown"),
        "state": state,
        "step": _text(raw.get("step"), "—"),
        "progress": max(0.0, min(1.0, float(progress))),
        "updated_at": _text(raw.get("updated_at")) or datetime.now(timezone.utc).isoformat(
            timespec="seconds").replace("+00:00", "Z"),
        "steps": steps,
        "note": _text(raw.get("note")),
    }


def fetch() -> dict[str, Any]:
    try:
        raw = command_json(STATUS_CMD, timeout=20)
    except Exception as exc:
        raise RuntimeError(f"status command failed: {exc}") from exc
    if not isinstance(raw, dict):
        raise RuntimeError("status command must print a JSON object")
    return normalize(raw)


def _age(stamp: str) -> float | None:
    try:
        then = datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None
    return max(0.0, (time.time() - then) * 1000)


def changes(old: Any, new: Any) -> list[dict[str, Any]]:
    if not isinstance(old, dict) or not isinstance(new, dict):
        return []
    job = new.get("job") or "job"
    events: list[dict[str, Any]] = []
    if old.get("state") != new.get("state"):
        events.append({"text": f"{job}: {old.get('state') or 'unknown'} → "
                               f"{new.get('state') or 'unknown'}", "kind": "state"})
    before = {step.get("name"): step.get("state") for step in old.get("steps") or []
              if isinstance(step, dict)}
    for step in new.get("steps") or []:
        if not isinstance(step, dict):
            continue
        after = step.get("state")
        if before.get(step.get("name")) != after and after in {"running", "failed"}:
            events.append({"text": f"{job}: step {step.get('name')} {after}",
                           "kind": "step", "step": step.get("name"), "to": after})
    return events


def every(data: Any) -> float:
    return IDLE_POLL if not isinstance(data, dict) or data.get("state") in DONE_STATES else ACTIVE_POLL


def view(board: Board) -> ui.Node:
    data = board.data if isinstance(board.data, dict) else {}
    state = data.get("state", "unknown")
    tone = STATE_TONE.get(state, "muted")
    progress = data.get("progress", 0.0)
    source = data.get("source", "unknown")
    source_label = {
        "demo-clock": "demo clock (local)",
        "file": "local file",
        "fixture": "fixture sample",
    }.get(source, source)
    note = data.get("note")
    updated = _age(data.get("updated_at", ""))
    steps = data.get("steps") or []

    rows: list[ui.Node] = []
    for index, step in enumerate(steps):
        icon, step_tone = STEP.get(step["state"], ("help", "muted"))
        at = step["at"][11:19] if len(step["at"]) >= 19 else ""
        rows.append(ui.row(
            ui.text(f"{index + 1:02d}", tone="muted", key=f"n:{index}"),
            ui.icon(icon, tone=step_tone, key=f"i:{index}"),
            ui.col(
                ui.text(step["name"], key=f"name:{index}"),
                ui.text(step["detail"], tone="muted", truncate="end",
                        key=f"detail:{index}") if step["detail"] else None,
                gap="none", key=f"label:{index}",
            ),
            ui.badge(step["state"], tone=step_tone, key=f"s:{index}"),
            ui.text(at, tone="muted", key=f"at:{index}"),
            gap="sm", align="center", key=f"row:{index}",
        ))

    return ui.col(
        ui.card(
            ui.row(
                ui.icon("activity", tone=tone, key="state-icon"),
                ui.col(
                    ui.text(data.get("job", "local-job"), key="job"),
                    ui.row(
                        ui.text(state, tone=tone, key="state"),
                        ui.badge(f"step {data.get('step', '—')}", key="step"),
                        gap="sm", key="state-line",
                    ),
                    gap="xs", key="state-main",
                ),
                ui.col(
                    ui.text(f"{round(progress * 100)}%", key="pct"),
                    ui.elapsed(updated, format="short", key="state-age")
                    if updated is not None else ui.text("age unknown", tone="muted",
                                                        key="state-age-unknown"),
                    gap="xs", align="end", key="state-side",
                ),
                gap="md", align="center", wrap=True, key="state-head",
            ),
            ui.meter(progress, label=f"{round(progress * 100)}% complete",
                     style="bar", size="md", key="progress"),
            ui.row(
                ui.badge(source_label, tone="info" if source == "demo-clock" else "muted",
                         key="source"),
                ui.text(note, tone="muted", wrap="word", key="note") if note else None,
                gap="sm", wrap=True, key="source-line",
            ),
            head="State", status=CARD_STATUS.get(state), key="state-card",
        ),
        ui.card(*rows, head="Timeline", key="timeline"),
        ui.text("Read-only local JSON command; it never writes status.", tone="muted", key="hint"),
        gap="md", key="root",
    )

BOARD = Board("Local job status", fetch=fetch, view=view, every=every, changes=changes)

if __name__ == "__main__":
    raise SystemExit(BOARD.run())
