---
name: handoff
description: Hand off task state to a fresh-context agent session. Writes a self-contained handoff document, then either spawns the new session with it as the first prompt, or only saves it to a temp file.
license: MIT
---

# Handoff Between Agent Contexts

Transfer durable task state through a deliberate, self-contained document, not through conversation history. The conversation is lossy (compaction, pruning, new sessions); the handoff is written once, on purpose, for a reader with no context.

The handoff is the new session's first prompt. Nothing is written into the worktree, so there is nothing to keep fresh, git-ignore, or delete. The reader starts seconds after the writer finishes, and a tree fingerprint lets it detect drift anyway. The document opens with its own instructions for the reader, so no separate skill is needed to consume it.

## When to Use This Skill

- The user asks for a handoff, or asks to continue the work in a fresh session.
- The `auto-handoff` plugin asks for one because the session crossed its context threshold (workstation profiles). That request is an automatic `do a handoff`: it continues the same work with no new direction from the user. Run the full `do a handoff` flow below, including model resolution with the `model-selector` skill (no user is present to name a model), then stop and do not resume the task in that session.
- On OpenChamber machines without the plugin (the coder profile), hand off only on an explicit user request, at a coherent safe checkpoint — never mid-edit, mid-deploy, or mid-test, and never merely because a task is long or changes phase. OpenChamber's cumulative-input budget for automatic handoff is defined but inactive: nothing on the tool surface identifies the current session among `openchamber.session.list` records, so never poll the list or approximate identity from recency, title, directory, or a handoff prompt. A handoff is one fresh session continuing the same unfinished task, never a way to split work into parallel subtasks.
- Subagents never create continuation sessions. A subagent under context or budget pressure reports that to its parent; the parent owns any continuation.
- Two user-facing modes, distinguished by wording:
  - `do a handoff` (also `handoff to a new session` / `handoff to a new agent`): write the document, then spawn the next session with it as the first prompt (see "Spawning the Next Session").
  - `create a handoff document` (also `write` / `update a handoff`): write the document only. Do not touch tmux or create a session. Report the file path and this ready-to-paste line for whichever session should take over: `Taking over after a handoff. Read <path> and follow it.`

## The Document

One markdown file that is the complete prompt for the new agent: fixed instructions first, then the state. Copy the opening paragraph verbatim; fill in the rest.

```markdown
# Handoff: <short task name>

You are taking over from another agent session, which is gone. This document is your starting state. Do not trust it blindly. Before acting:
1. Verify it against the repository: `git status`, `git log --oneline -10`, and the files it names. Recompute the tree fingerprint below; if it differs, the tree changed after this was written. The repository wins over this document.
2. Restate the mission and your first action in at most three bullets. If the User section lists anything the user has not been told yet, report that to them first.
3. Then continue with Next actions.

Repo: <worktree path> | Branch: <branch> | HEAD: <sha>
Tree: <fingerprint> (recompute: `{ git rev-parse HEAD; git status --porcelain; git diff HEAD; } | shasum | cut -c1-12`)

## Follow-up from the user
<only when the request carried one, e.g. `do a handoff and continue with X`; it takes priority over Next actions>

## Mission
1-3 sentences describing the done-state.

## User
- <choice the user made: names, locations, trade-offs they picked>
- <constraint or preference they stated>
- Not yet told: <findings, results, or caveats the user has not heard>

## Current state
What exists and works now; what is in flight; which changes are uncommitted (pointer: `git status --short`).

## Decisions
- <technical decision you made> — <one-line rationale, so a fresh agent does not relitigate it>

## Verified facts
- <fact> — <evidence pointer: file:line, exact bounded command, or link>

## Pitfalls
- <warning> — <what to do instead>

## State outside the repo
- <thing> — <where it lives and how to inspect it>

## Open questions
- <unresolved question and what would resolve it>

## Next actions
1. <immediately executable step>
2. <subsequent step>

## Verify
- <commands that prove correctness: tests, lint, build>
```

Section guidance:

- **User**: what the user chose or asked for, as opposed to what you decided. A handoff happens mid-conversation, and the new agent's first job is often to report back, so record what the user is still owed.
- **Pitfalls**: the warnings that are most expensive to rediscover. Environment variables the shell inherited, tools or plugins that misfire, files or settings that must not be deleted or changed, commands that look safe but are not. Keep them here, not in Verified facts where they get skimmed past.
- **State outside the repo**: things that live on the user's machine or remote systems and shape the work. Logged-in profiles and contexts (gcloud, kubectl, cloud accounts), login or session state, running or stale processes, tmux panes, exported variables, scripts or files in temp directories that may disappear (say whether it is the only copy), untracked or ignored files that must survive. Name how to inspect each; never include contents.

## Writing the Document

1. Recall first, precision second. There is no length cap: include everything whose loss would hurt and trim only redundancy. A long handoff is fine; an incomplete one is not. Never include raw logs, diffs, plans, or documentation — pointers to them instead.
2. Compute the `Repo:` and `Tree:` lines with commands at write time, not from memory. The fingerprint covers HEAD, the status listing, and tracked changes, not the contents of untracked files, so list untracked files that matter under Current state.
3. Facts are pointers, not contents: `src/api/auth.ts:42`, `kubectl --context X get pods -n Y`, a URL. The fresh agent loads details just-in-time.
4. Record decisions with rationale; a fresh agent that knows *why* will not undo them.
5. No secrets, ever: the document is stored in the new session's history and in a temp file. Name where a credential lives (variable name, secret-store path), never its value.
6. Write it with an available file-editing tool to the OpenCode temp dir named in your environment info (otherwise `${TMPDIR:-/tmp}`) as `handoff-<task-slug>.md`. Keep it out of the worktree.
7. A saved document is a snapshot. If the work moves on, write a new one (same path is fine) rather than patching the old.

## Spawning the Next Session (`do a handoff` only)

After writing the document:

1. The prompt is the document's exact contents. Prepend nothing.
2. Resolve the model and reasoning effort (for the CLI path in step 4; the OpenChamber path below has its own rules):
   - Parse an optional model clause either adjacent to the handoff phrase or as a standalone clause at the end of the request: `[with | using | on | use] <model> [<effort>]`. A trailing clause must resolve to a full model ID or a known alias below; otherwise treat it as task text. Remove the clause from the follow-up. Examples: `do a handoff with opus high`, `handoff to a new session using gemini-3-flash low`, `handoff to a new agent to plan the migration. use glm 5.3 high`.
   - No model clause: invoke the `model-selector` skill. Give it a compact factual brief, not the whole document: mission, unresolved decisions, prior failures, next actions, and verification. The selector keeps only the first 8,000 characters, and never wants raw logs or the full conversation. Use its one-line JSON result's `agent`, `model`, and `effort` fields for the session in step 4. This is one local state read plus one Jev Choice request with a 3-second timeout; do not run extra model or quota lookups. If it falls back, use its returned `general` agent.
   - Agent names (`general`, `coder`, `terminal`, `quick`, `deep`, or any other `mode: "all"` agent in `~/.config/opencode/subagents.jsonc`): resolve with `node ~/.agents/skills/model-selector/scripts/select.mjs --agent <name>` and use its `agent`, `model`, and `effort` fields. A trailing effort word overrides its `effort`.
   - Do not maintain a second model-alias table in this skill. Agent routes belong in `subagents.jsonc`; family names such as `sol` are resolved against the current catalog, never silently mapped to an older generation.
   - A full `provider/model` ID must be available in the current model catalog. Check the exact ID and any requested variant with the models listing tool; do not infer or normalize identifiers.
   - Any other `<model>` is a short name. Compare it to the `opencode models` output (full `provider/model` IDs) as a case-insensitive substring, with spaces, dots, underscores, and hyphens all treated as the same separator, so `claude opus 5.5` matches `claude-subscription/claude-opus-5-5`:

     ```bash
     needle=$(printf %s "<model>" | tr '[:upper:]' '[:lower:]' | tr ' ._' '---')
     opencode models | awk -v n="$needle" '{ l=tolower($0); gsub(/[ ._]/,"-",l); if (index(l,n)) print }'
     ```

     - 1 match: use it.
     - 0 matches: warn, then create the session in step 4 without a `model` field (the prompt still auto-starts on the server default). Do not send an invented or unverified model ID: session creation accepts unknown models without error and the failure only surfaces after the prompt is submitted.
     - Many matches: if one is exact, use it; otherwise stop and ask the user to pick (list at most ~10). Never guess among many.
   - `<effort>` is an optional space-separated word: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (case-insensitive). Acknowledge it in your one-line report, and pass it as `variant` in the session `model` object in step 4 (unlike the root TUI default, a session created with an explicit variant keeps it — verified live). If no effort is specified, omit `variant` (or preserve a `#variant` already on a supplied full ID). The selector's profiles have supported effort values.
   - Split the resolved model for the session `model` object: `providerID` is the part before the first `/`, `id` is the rest minus any `#variant`. A `#variant` already on a supplied full ID wins over a separate effort word; never send both.
3. Spawning is client-dependent. A shared server's inherited tmux variables do not prove this session came from a TUI; use the current client's context, and default to session-list presentation when uncertain:
    - **OpenChamber with the `openchamber` tool** (the coder profile): no CLI and no tmux. Follow the "OpenChamber path" section below instead of step 4.
    - **Confirmed tmux TUI** (the current client is in tmux and both `TMUX` and `TMUX_PANE` are present): follow step 4 with `attach_tmux=true`. The new session gets its own pane, which is what the user expects from "do a handoff".
   - **Outside tmux, but on a server with a session API** (the `opencode` CLI can address server-side sessions): still create the session in step 4 and submit the document, but run no `tmux` command. The new session is already live and appears in the client's session list. Report its ID and the document path; use that client's own tooling to surface or open the session if it has a way to do so.
   - **Neither** (no tmux and no session API): skip creating a session, report the document path and the ready-to-paste line from "When to Use This Skill", and still succeed — the document is the handoff.

   The document is the handoff in every case. A pane or a listed session is a convenience, never the deliverable.
4. **CLI path.** Create the session server-side with the resolved model, submit the document as the prompt through the API, and attach the **full TUI** to that live session. The root TUI has no `--model` flag, so set the model at session creation; an explicit session model and `variant` are honored, and the API-submitted prompt starts execution automatically:

```bash
worktree="<worktree-path>"
file="<path of the handoff document>"
title="Handoff: <short task name>"
agent="<agent from model-selector or an agent alias, or empty>"
provider="<providerID, or empty when no valid model override exists>"
model_id="<model ID without #variant, or empty>"
effort="<effort/variant, or empty>"
attach_tmux=false # Set true only for the confirmed tmux TUI branch in step 3.

payload=$(jq -n --arg title "$title" --arg dir "$worktree" --arg agent "$agent" --arg provider "$provider" --arg id "$model_id" --arg variant "$effort" \
  '{title:$title,location:{directory:$dir}} + (if $agent != "" then {agent:$agent} else {} end) + (if $provider != "" then {model:({providerID:$provider,id:$id} + (if $variant != "" then {variant:$variant} else {} end))} else {} end)')
sid=$(opencode api post /api/session -d "$payload" | jq -r .data.id) || exit 1
[ -n "$sid" ] && [ "$sid" != null ] || exit 1
body=$(jq -n --rawfile text "$file" '{text:$text}')
if ! opencode api post /api/session/$sid/prompt --param sessionID=$sid -d "$body" >/dev/null; then
  printf 'Prompt receipt uncertain for session %s; preserve it and inspect before retrying. Document: %s\n' "$sid" "$file" >&2
  exit 1
fi
if [ "$attach_tmux" = true ] && [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ]; then
  if ! tmux split-window -h -c "$worktree" -t "$TMUX_PANE" opencode --session "$sid"; then
    printf 'Session %s is already running; opening a tmux pane failed. Open it from the session list.\n' "$sid" >&2
  fi
fi
printf 'Handoff session: %s\n' "$sid"
```

Pass `"$body"` to `--data` directly as an argument; never pipe it through `echo` in zsh (which rewrites `\n` escapes and corrupts multiline prompts). Build it from the file with `jq --rawfile` so the document is never re-quoted by the shell.

5. Do not send keys or submit the prompt a second time. Report the session ID, the model used, and the document path. In tmux the new agent normally has a pane to the right; in OpenChamber it appears in the session list. A missing pane does not mean the successor failed.
6. A session-creation or prompt-submission failure never loses the handoff — the document is still at its path. Report that failure and the path, then stop. A pane failure is only a presentation warning: report the already-running successor's ID and do not create another session. Leave the file in place after a successful spawn too; the temp dir is disposable. Do not write the model into the document; the spawn commands are the only place it appears.

### OpenChamber path

When the current client offers the `openchamber` tool, that tool — not the CLI and not tmux — creates the successor. After writing the document:

1. Resolve any explicitly requested model before creating the session. Omit `agent`, `model`, and `variant` unless the user explicitly requested one. Omission is intentional: the successor inherits the owner's current default model and variant rather than copying the outgoing session's. When the user names a model, use the single `openchamber` tool with `{action: "models.list", parameters: {}}` immediately before creating the session and resolve the request to an available exact `providerID/modelID` — exact full identifier first, then exact model ID, then the closest normalized name match, breaking ties in favor of a favorite, then a recent model. Pass that exact identifier as `model`, and a supported `variant` only when the user also named one. Never invent a provider or model identifier; if no candidate is available, omit `model` and say so in the handoff report.
2. Use the single `openchamber` tool with `{action: "session.create", parameters: {directory, title, prompt}}`: set `directory` to the current absolute working directory, `title` to `Handoff: <short task name>`, and `prompt` to the document's exact contents (prepend nothing). Add any explicitly requested fields resolved in step 1. Discover and call the tool by its actual advertised name; `session.create` and `models.list` are actions, not separate callable tools. Do not request a worktree or branch: the successor continues in the current checkout and must preserve all existing worktree changes.
3. Report the new session's title and ID, state that it owns the remaining work, and stop. Do not wait for it, poll it, or send it follow-up prompts; it appears in the client's session list, and there is no pane to attach.
4. If session creation fails, preserve the document and report the failure, its path, and any returned session ID. A timeout or lost response can occur after server-side submission: uncertain receipt does not prove that no successor exists. On uncertainty, stop without continuing the task or creating another successor until ownership is resolved. Continue in the current session only when non-submission is confirmed.
