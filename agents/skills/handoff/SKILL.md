---
name: handoff
description: Write or read a worktree-local HANDOFF.md that transfers task state to a fresh-context agent session. Use ONLY when the user explicitly asks to create, update, read, or use a handoff document. Never invoke proactively.
license: MIT
---

# Handoff Between Agent Contexts

Transfer durable task state through a file, not through conversation history. The conversation is lossy (compaction, pruning, new sessions); the file is not.

## When to Use This Skill

- Only when the user explicitly asks to create, update, read, or use a handoff document.
- Do not invoke this skill because work is unfinished, a task changes phase, context is getting long, a session is ending, compaction is imminent, or work is delegated to another agent.
- Two write modes, distinguished by wording:
  - `create a handoff document` (also `write` / `update a handoff`): write `HANDOFF.md` only. Do not touch tmux.
  - `do a handoff` (also `handoff to a new session`): write `HANDOFF.md` first, then spawn the next session (see below).

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
5. Reconcile discrepancies against ground truth, then delete the file immediately and proceed without it. A consumed handoff is never updated in place.

## Completing the Work

After taking over from a fresh handoff, delete `HANDOFF.md` (and its exclude entry) immediately and continue without it. Never keep updating it in place. If you forget, nothing breaks: the next session to encounter the file applies the scope check and freshness gate, and a stale file is deleted on sight — it is inert garbage, never an input. Forgetting to delete costs disk clutter, not correctness.

## Spawning the Next Session (`do a handoff` only)

After writing `HANDOFF.md` (write path only, never on read):

1. Build the initial prompt:
   - If the user supplied a follow-up in the same request (e.g. `do a handoff and continue with X`), use: `Taking over after handoff. X. Start by reading HANDOFF.md with the handoff skill.`
   - Otherwise use the default: `Taking over after handoff. Read HANDOFF.md with the handoff skill and continue with Next actions.`
2. Resolve the model and reasoning effort:
   - Parse an optional model clause adjacent to the handoff verb: `do a handoff [with | using | on <model> [<effort>]]`. Examples: `do a handoff with opus`, `do a handoff with opus high`, `handoff to a new session using gemini-3-flash low`. The clause must sit next to the handoff verb so a later `and continue with X` is treated as the follow-up, not the model.
   - No model clause: invoke the `model-selector` skill. Give it a compact factual brief of the remaining work (the completed `HANDOFF.md`, follow-up, unresolved decisions, prior failures, and verification), never raw logs or the full conversation. Use its one-line JSON result as `--model "<model>#<effort>"`. This is one local cache read plus one Jev Choice request with a 3-second timeout; do not run extra model or quota lookups. If it falls back, use its returned workhorse.
   - `<model>` is a short name, matched case-insensitively as a substring against `opencode models` output (full `provider/model` IDs). A full `provider/model` ID matches exactly and is used as-is.
     - 1 match: use it.
     - 0 matches: warn, then spawn without `--model` (the file is still the handoff).
     - Many matches: if one is exact, use it; otherwise stop and ask the user to pick (list at most ~10). Never guess among many.
   - `<effort>` is an optional space-separated word: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (case-insensitive). If the word after `<model>` is not in this list, there is no explicit effort. Default: `medium`.
   - Validate the effort with `opencode models --verbose` (the resolved model's `variants` keys):
     - Effort present: spawn `--model "<provider/model>#<effort>"`.
     - Effort absent: pick the nearest variant by rank (`none < minimal < low < medium < high < xhigh < max`), ties prefer the higher one, and report the substitution (e.g. `medium unavailable on <model>, using high`).
     - Empty `variants` (e.g. `big-pickle`): spawn bare `--model "<provider/model>"` with no suffix and say so.
   - Quote the full `--model` value; IDs contain `/`, `@`, `#`.
3. Only spawn if inside tmux (`${TMUX:-}` is non-empty). If not in tmux, skip spawning, report it, and still succeed — the file is the handoff.
4. Open a new pane to the right, rooted at the worktree containing `HANDOFF.md`, with the prompt pre-filled (not submitted — `opencode --prompt` only pre-fills the textbox, so the user presses Enter when ready):

```bash
# model requested (effort always present: explicit or defaulted to medium):
tmux split-window -h -c "<worktree-path>" -t "$TMUX_PANE" opencode --model "<provider/model>#<effort>" --prompt "Taking over after handoff. ..."

# no model requested: use the model-selector result:
tmux split-window -h -c "<worktree-path>" -t "$TMUX_PANE" opencode --model "<selector model>#<selector effort>" --prompt "Taking over after handoff. ..."
```

5. Never use `tmux send-keys` to type into the new pane, never auto-submit. The user continues typing after the pre-filled text.
6. A split failure never invalidates the handoff — report it and stop. Do not record the model in `HANDOFF.md`; the spawn command is the only place it appears.
