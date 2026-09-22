---
name: takeover
description: Consume a worktree-local HANDOFF.md left by a previous agent session. Verify scope and freshness against the repository, restate the mission, delete the file, and continue the work. Use when a session starts with "Taking over after handoff" or the user asks to read, consume, or take over a HANDOFF.md. Never invoke proactively.
license: MIT
---

# Take Over From a Handoff

`HANDOFF.md` at the worktree root is durable task state written by a previous session (see the `handoff` skill for the writer's contract, including the meaning of the `Base:` sha). Your job: validate it, extract the mission, delete it, continue the work.

## When to Use This Skill

- Your prompt starts with `Taking over after handoff`, or names `HANDOFF.md` as your starting point.
- The user asks you to read, consume, or take over a handoff document.
- Do not invoke proactively; the file's presence alone in unrelated work is not a trigger — it is inert unless you were pointed at it.

## Taking Over

1. Scope check: if the file's `Base:` line names a different worktree or branch than the current one, it belongs to different work — ignore it and do not delete it.
2. Freshness gate: compare the file's `Base:` sha to `git rev-parse HEAD`. Equal means fresh: nothing has happened since it was written. Not equal means work occurred after the handoff without updating it — delete the file and proceed without it. This gate is binary; do not interpret a stale file's contents.
3. Verify a fresh handoff against ground truth before trusting it: `git status`, `git log --oneline -10`, and the files it names. Handoffs rot; the repository wins.
4. Restate the mission and the next action in at most three bullets before acting — this is the checksum that catches a garbled or stale handoff.
5. Reconcile discrepancies against ground truth, then delete the file immediately (remove its `.git/info/exclude` entry too, if present) and proceed without it.

## Rules

- A consumed handoff is never updated in place. If the work later needs its own handoff, the `handoff` skill writes a new file.
- Forgetting to delete costs nothing beyond clutter: the next session to encounter the file applies the same scope check and freshness gate, and a stale file is deleted on sight — it is inert garbage, never an input.
- No secrets are ever in the file by contract; if you find one, stop and report it.
