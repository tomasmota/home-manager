---
name: handoff
description: Write a worktree-local HANDOFF.md that transfers task state to a fresh-context agent session, optionally spawning it in a new tmux pane. Use ONLY when the user explicitly asks to create, update, or write a handoff document. Taking one over is the takeover skill's job. Never invoke proactively.
license: MIT
---

# Handoff Between Agent Contexts

Transfer durable task state through a file, not through conversation history. The conversation is lossy (compaction, pruning, new sessions); the file is not.

This skill is the writer's side. The reader's side (scope check, freshness gate, deletion) lives in the `takeover` skill; the `Base:` sha contract spans both — change it in one, change it in both.

## When to Use This Skill

- Only when the user explicitly asks to create, update, or write a handoff document.
- Do not invoke this skill because work is unfinished, a task changes phase, context is getting long, a session is ending, compaction is imminent, or work is delegated to another agent.
- Two write modes, distinguished by wording:
  - `create a handoff document` (also `write` / `update a handoff`): write `HANDOFF.md` only. Do not touch tmux.
  - `do a handoff` (also `handoff to a new session` / `handoff to a new agent`): write `HANDOFF.md` first, then spawn the next session (see below).

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

Not this skill's job. The taker-over loads the `takeover` skill, which owns the scope check, freshness gate against `Base:`, verification, and immediate deletion of the consumed file.

## Spawning the Next Session (`do a handoff` only)

After writing `HANDOFF.md` (write path only, never on read):

1. Build the initial prompt:
   - If the user supplied a follow-up in the same request (e.g. `do a handoff and continue with X`), use: `Taking over after handoff. X. Take over HANDOFF.md with the takeover skill.`
   - Otherwise use the default: `Taking over after handoff. Take over HANDOFF.md with the takeover skill and continue with Next actions.`
2. Resolve the model and reasoning effort:
   - Parse an optional model clause either adjacent to the handoff phrase or as a standalone clause at the end of the request: `[with | using | on | use] <model> [<effort>]`. A trailing clause must resolve to a full model ID or a known alias below; otherwise treat it as task text. Remove the clause from the follow-up prompt. Examples: `do a handoff with opus high`, `handoff to a new session using gemini-3-flash low`, `handoff to a new agent to plan the migration. use glm 5.3 high`.
   - No model clause: invoke the `model-selector` skill. Give it a compact factual brief of the remaining work (the completed `HANDOFF.md`, follow-up, unresolved decisions, prior failures, and verification), never raw logs or the full conversation. Use its one-line JSON result's `model` field as the full-TUI default via `OPENCODE_CONFIG_CONTENT` (see step 4). This is one local cache read plus one Jev Choice request with a 3-second timeout; do not run extra model or quota lookups. If it falls back, use its returned workhorse.
   - Resolve these aliases first, case-insensitively; spaces and hyphens are equivalent. These are authoritative: do not call `opencode models` or inspect verbose model metadata for them.
     - `glm 5.3` -> `zai-coding-plan/glm-5.3`
     - `glm 5.3 flash` -> `zai-coding-plan/glm-5.3-flash`
     - `glm 5.3 highspeed` -> `zai-coding-plan/glm-5.3-highspeed`
     - `gpt 5.6 terra` / `terra` -> `openai/gpt-5.6-terra`
     - `gpt 6 astra` / `astra` -> `openai/gpt-6-astra`
     - `quick` -> `zai-coding-plan/glm-5.3-flash`
     - `workhorse` -> `openai/gpt-5.6-terra`
     - `workhorse zai` -> `zai-coding-plan/glm-5.3`
     - `deep` -> `openai/gpt-6-astra`
   - Match the longest known alias, so `glm 5.3 flash` never resolves as `glm 5.3`. A trailing effort word (`high`, `medium`, ...) is consumed as an effort, never as part of the model name; only the word `highspeed` selects the highspeed model.
   - A full `provider/model` ID is authoritative and used as-is without a model-name lookup; check its variants only when the user also requests an effort.
   - Any other `<model>` is a short name, matched case-insensitively as a substring against one `opencode models` result (full `provider/model` IDs).
     - 1 match: use it.
     - 0 matches: warn, then spawn the root `opencode` TUI without a model override (the file is still the handoff).
     - Many matches: if one is exact, use it; otherwise stop and ask the user to pick (list at most ~10). Never guess among many.
   - `<effort>` is an optional space-separated word: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (case-insensitive). Acknowledge it in your one-line report, but do not pass it to the full TUI: the root default model does not retain a `#variant` (verified live: `#medium` fell back to the model's built-in default effort), and only `mini`/`run` accept `#effort` via `--model`. If no effort is specified, use the bare ID (or preserve a supplied `#variant` for `mini`/`run` contexts). The selector's profiles have supported effort values.
   - Quote the full `--model` value; IDs can contain `/`, `@`, `#`. Never append a second `#variant` to a full ID that already has one.
3. Only spawn if inside tmux (`${TMUX:-}` is non-empty). If not in tmux, skip spawning, report it, and still succeed — the file is the handoff.
4. Set `initial_prompt` from step 1, then open a new pane to the right, rooted at the worktree containing `HANDOFF.md`, running the **full TUI**. The root TUI has no `--model` flag, so pass a selected model as the default via `OPENCODE_CONFIG_CONTENT` (inline JSON merged over config files at highest precedence; everyday launches without the variable are unaffected). `--prompt` **submits the prompt automatically**, so the next agent begins the takeover without waiting for the user to press Enter:

```bash
# model_ref is the resolved bare provider/model (no #variant: the full TUI drops it).
tmux split-window -h -c "<worktree-path>" -t "$TMUX_PANE" \
  -e 'OPENCODE_CONFIG_CONTENT={"model":"'"$model_ref"'"}' \
  opencode --prompt "$initial_prompt" || exit 1

# If no valid model override exists, use this instead:
# tmux split-window -h -c "<worktree-path>" -t "$TMUX_PANE" \
#   opencode --prompt "$initial_prompt" || exit 1
```

5. Do not send keys or submit the prompt a second time. Report the model used; the new agent continues automatically in the pane to the right.
6. A split failure never invalidates the handoff — report it and stop. Do not record the model in `HANDOFF.md`; the spawn command is the only place it appears.
