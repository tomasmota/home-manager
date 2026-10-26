#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tern-sdk==0.1.0"]
# ///
"""Static decision brief with a real pick button on each option card.

The data is complete and generic; there is no live source and no network call.
A pick emits a `pick` event and marks the card locally.
"""

from __future__ import annotations

import copy
from typing import Any

from tern_sdk import ui

from ternui import Board

DECISION: dict[str, Any] = {
    "id": "feature-flag-evaluation",
    "title": "Where should feature flags be evaluated?",
    "context": "A public HTTP API and its web client need per-account flags. Flags change "
               "without a redeploy, assignment stays consistent across two regions, and "
               "peak traffic is 8k requests per second.",
    "constraints": [
        "Change flags without redeploying",
        "Consistent per-account bucketing",
        "p99 added latency under 5 ms",
        "No new always-on infrastructure",
    ],
    "recommendation": {
        "option": "in-service",
        "reason": "Keep request context and latency local; share fixtures between the Go "
                  "and TypeScript evaluators so parity is testable.",
    },
    "options": [
        {
            "id": "in-service",
            "title": "Evaluate inside each service",
            "summary": "Load rules from the config service and evaluate in-process per request.",
            "rationale": "Request context is already present, and the decision stays next to "
                         "the code that uses it.",
            "tradeoff": "Two evaluator implementations must agree on bucketing and defaults.",
            "pros": ["Lowest latency", "Full request context", "Survives control-plane outage"],
            "cons": ["Two SDKs to keep in parity", "Per-service cache and refresh loop"],
            "effort": "Medium · 4–6 days",
            "risk": "Low",
        },
        {
            "id": "edge",
            "title": "Evaluate at the edge",
            "summary": "Push rules to edge workers and decide before requests reach origin.",
            "rationale": "One evaluation point serves every region and runtime without "
                         "changing service code.",
            "tradeoff": "The edge sees less context and adds a platform dependency to the "
                        "request path.",
            "pros": ["Single implementation", "Near-user latency", "Region-local rollout"],
            "cons": ["Runtime limits and cold starts", "Limited account state",
                     "Harder local replay"],
            "effort": "High · 2–3 weeks",
            "risk": "Medium",
        },
        {
            "id": "precompute",
            "title": "Precompute assignments in a background job",
            "summary": "Write per-account assignments to a low-latency store that services read.",
            "rationale": "Evaluation leaves the request path and every runtime reads the same "
                         "plain values.",
            "tradeoff": "Assignments lag rule changes and storage grows with accounts × flags.",
            "pros": ["Cheap constant-time reads", "Deterministic output", "Auditable assignments"],
            "cons": ["Lag after a change", "Storage growth", "Backfill and invalidation work"],
            "effort": "High · 2 weeks",
            "risk": "Medium",
        },
    ],
    "note": "Static generic example. Picks are events, not executed commands.",
}

CHOSEN: str | None = None
RISK_TONE = {"Low": "success", "Medium": "warning", "High": "error"}


def fetch() -> dict[str, Any]:
    return copy.deepcopy(DECISION)


def choose(board: Board, option: dict[str, Any]) -> None:
    global CHOSEN
    if CHOSEN == option["id"]:
        return
    CHOSEN = option["id"]
    board.pick(
        f"Chose {option['title']}",
        decision=board.data["id"], option=option["id"], title=option["title"],
        rationale=option["rationale"], tradeoff=option["tradeoff"],
        effort=option["effort"], risk=option["risk"],
    )
    board.refresh()


def view(board: Board) -> ui.Node:
    data = board.data if isinstance(board.data, dict) else {}
    recommended = (data.get("recommendation") or {}).get("option")
    cards: list[ui.Node] = []
    for option in data.get("options") or []:
        if not isinstance(option, dict):
            continue
        chosen = CHOSEN == option["id"]
        badges: list[ui.Node] = [
            ui.badge(option["effort"], tone="info", key=f"effort:{option['id']}"),
            ui.badge(f"risk {option['risk'].lower()}",
                     tone=RISK_TONE.get(option["risk"], "muted"), key=f"risk:{option['id']}"),
        ]
        if option["id"] == recommended:
            badges.append(ui.badge("recommended", tone="success", key=f"rec:{option['id']}"))
        if chosen:
            badges.append(ui.badge("picked", tone="accent", key=f"picked:{option['id']}"))
        cards.append(ui.card(
            ui.text(option["summary"], wrap="word", key=f"summary:{option['id']}"),
            ui.text(option["rationale"], wrap="word", key=f"rationale:{option['id']}"),
            ui.row(
                ui.col(
                    ui.text("Pros", tone="success", key=f"pros-title:{option['id']}"),
                    *[ui.text(f"+ {item}", wrap="word", key=f"pro:{option['id']}:{index}")
                      for index, item in enumerate(option["pros"])],
                    gap="xs", key=f"pros:{option['id']}",
                ),
                ui.col(
                    ui.text("Cons", tone="warning", key=f"cons-title:{option['id']}"),
                    *[ui.text(f"− {item}", wrap="word", key=f"con:{option['id']}:{index}")
                      for index, item in enumerate(option["cons"])],
                    gap="xs", key=f"cons:{option['id']}",
                ),
                gap="lg", align="start", wrap=True, key=f"tradeoffs:{option['id']}",
            ),
            ui.text(f"Trade-off: {option['tradeoff']}", tone="muted", wrap="word",
                    key=f"tradeoff:{option['id']}"),
            ui.row(*badges, gap="sm", wrap=True, key=f"badges:{option['id']}"),
            ui.row(
                ui.html.button(
                    "Picked" if chosen else "Pick this option",
                    class_="tu-button",
                    attrs={"disabled": "disabled"} if chosen else None,
                    on_click=None if chosen else (
                        lambda _event, item=option: choose(board, item)),
                    key=f"pick:{option['id']}",
                ),
                ui.text("Queued for the agent." if chosen else "Records a pick event.",
                        tone="muted", key=f"pick-note:{option['id']}"),
                gap="sm", align="center", wrap=True, key=f"actions:{option['id']}",
            ),
            head=option["title"], selected=chosen, status="done" if chosen else None,
            key=f"option:{option['id']}",
        ))

    return ui.col(
        ui.card(
            ui.text(data.get("context", ""), wrap="word", key="context"),
            ui.row(
                *[ui.badge(item, tone="muted", key=f"constraint:{index}")
                  for index, item in enumerate(data.get("constraints") or [])],
                gap="sm", wrap=True, key="constraints",
            ),
            ui.text("Recommendation: " + (data.get("recommendation") or {}).get("reason", ""),
                    wrap="word", key="reason"),
            ui.text(data["note"], tone="muted", key="note") if data.get("note") else None,
            head=data.get("title", "Decision"), key="brief",
        ),
        ui.text("Pick one option. Choices are emitted as events, not executed commands.",
                tone="muted", key="hint"),
        *cards,
        gap="md", key="root",
    )


BOARD = Board("Decision brief", fetch=fetch, view=view, every=3600)

if __name__ == "__main__":
    raise SystemExit(BOARD.run())
