---
name: handoff
description: Write and read a worktree-local HANDOFF.md that transfers task state to a fresh-context agent session with minimal loss. Use when the user says handoff, hand off, wrap up, resume, or continue earlier work, or when a multi-step task hits a phase boundary, the context is getting long, or the session is ending or about to be compacted.
license: MIT
---

# Handoff Between Agent Contexts

Transfer durable task state through a file, not through conversation history. The conversation is lossy (compaction, pruning, new sessions); the file is not.

## When to Use This Skill

- The user asks for a handoff, to wrap up, or to continue/resume earlier work.
- A multi-step task hits a phase change (research done → implementing, plan agreed → executing).
- Context is getting long or a session is ending, and the work is not finished.
- Delegating deep task context to a subagent: write the handoff, then point the task prompt at it instead of inlining everything.

## The Artifact

One file, `HANDOFF.md`, at the worktree root. Structure:

```markdown
# Handoff: <short task name>
Base: <HEAD sha at write time> | Branch: <branch> | Worktree: <path>

## Mission
1-3 sentences describing the done-state.

## Current state
What exists and works now; what is in flight.

## Decisions
- <decision> — <one-line rationale, so a fresh agent does not relitigate it>

## Verified facts
- <fact> — <evidence pointer: file:line, exact bounded command, or link>

## Open questions
- <unresolved question and what would resolve it>

## Next actions
1. <immediately executable step>
2. <subsequent step>

## Verify
- <commands that prove correctness: tests, lint, build>
```

## Writing a Handoff

1. Recall first, precision second: include everything whose loss would hurt, then trim redundancy. Never include raw logs, diffs, plans, or documentation — pointers to them instead.
2. Record `Base:` as the output of `git rev-parse HEAD` at write time, plus the current branch and worktree path. This is the validity anchor: the handoff is fresh only while HEAD equals `Base`.
3. If you commit anything after writing the handoff, update the file (new `Base:`, adjusted state) — otherwise the next reader will correctly treat it as stale.
4. Facts are pointers, not contents: `src/api/auth.ts:42`, `kubectl --context X get pods -n Y`, a URL. The fresh agent loads details just-in-time.
5. Record decisions with rationale; a fresh agent that knows *why* will not undo them.
6. No secrets, ever.
7. If the file is not a deliberate tracked artifact of the repository, exclude it: `echo HANDOFF.md >> .git/info/exclude`.
8. Rewrite the file, do not append to it: stale sections get corrected, not accumulated.

## Reading a Handoff

1. Scope check: if the file's worktree or branch does not match the current one, it belongs to different work — ignore it and do not delete it.
2. Freshness gate: compare the file's `Base:` sha to `git rev-parse HEAD`. Equal means fresh: nothing has happened since it was written. Not equal means work occurred after the handoff without updating it — delete the file and proceed without it. This gate is binary; do not interpret a stale file's contents.
3. Verify a fresh handoff against ground truth before trusting it: `git status`, `git log --oneline -10`, and the files it names. Handoffs rot; the repository wins.
4. Restate the mission and the next action in at most three bullets before acting — this is the checksum that catches a garbled or stale handoff.
5. Reconcile discrepancies by updating the file, then proceed.

## Completing the Work

When the task is done, delete `HANDOFF.md` (and its exclude entry). If you forget, nothing breaks: the next session to encounter the file applies the scope check and freshness gate, and a stale file is deleted on sight — it is inert garbage, never an input. Forgetting to delete costs disk clutter, not correctness.
