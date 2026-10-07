---
name: handoff
description: >
  Transfer work to a fresh native omp session in Paseo or a full omp TUI in tmux,
  or start a focused investigation with an explicitly requested model and thinking level.
  Use for "handoff to a new agent to continue the work", "create a new GPT 6.1
  Sol High session to investigate X", or requests to write a handoff document.
license: MIT
metadata:
  verified: '2026-10-07'
  runtime: omp
---

# Handoff to a fresh omp session

Transfer durable task state through a self-contained document, not conversation
history. The successor has no access to your eval kernel, tool handles or memory.
This skill starts a fresh native omp session in Paseo or a full interactive omp
TUI in tmux. It does not create a `task` subagent, resume a conversation or fork
the outgoing session.

## Request and ownership

- **Continue the work**: "handoff to a new agent", "handoff to a new session",
  "handoff to a new agent to continue the work". Transfer the unfinished mission.
  After a successful launch, report the destination and stop work here. Do not
  wait for, poll or prompt the successor again.
- **New focused session**: "Create a new GPT 6.1 Sol High session to investigate
  the thing X that you mentioned". Recover what X means from this conversation;
  include the relevant findings, evidence and constraints in a focused document.
  Its mission is X, not every unfinished task in the parent. State which session
  owns which scope. Default an investigation to read-only unless the user asked
  it to implement a change; never have both sessions edit the same files.
- **Document only**: "create/write/update a handoff document". Save the document;
  do not run the launcher or touch tmux. Report its path and this ready-to-paste
  prompt: `Taking over after a handoff. Read <path> and follow it.`
- A follow-up such as "and investigate X" takes priority over the old next steps.
  Record it verbatim, with the context needed to understand references like X.
- Only the parent creates these sessions. Subagents report state to their parent.
  Do not auto-handoff because a task is long, changes phase or approaches a limit.
- Reach a safe checkpoint first: finish an in-flight edit or bounded command;
  preserve user changes. Do not start new task work just to prepare the handoff.

## Write the document

Use the file-writing tool to create a unique `handoff-<task-slug>-<nonce>.md` under
`${TMPDIR:-/tmp}`. Keep it outside the worktree. Each launch gets an immutable
snapshot; do not overwrite a document another session may still be reading.
Never include credentials, raw logs, diffs or copied documentation. Include
pointers and rationale. There is no arbitrary length cap, but omp's `@file`
loader skips contents above 5 MiB; the launcher rejects that case.

Compute repository metadata at write time, not from memory. For a Git checkout:

```sh
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git status --short
{ git rev-parse HEAD; git status --porcelain; git diff HEAD; } | shasum | cut -c1-12
```

This fingerprint does not cover untracked file contents. Name important
untracked/ignored files and how to inspect them. For non-Git work, omit branch,
HEAD and fingerprint; record the actual directory and relevant state instead.

Use this template. Keep the opening instructions; omit empty optional sections.
Do not put model selection in the document: the launcher owns that.

```markdown
# Handoff: <short task name>

You are taking over a scoped mission from another omp session. This document is
your starting state, not proof. Before acting:
1. Read the applicable repository instructions and the files named here. Inspect
   the current repository state and recompute the fingerprint when supplied.
   The repository wins over this snapshot. Preserve all existing user changes.
2. Restate your mission and first action in at most three bullets. Report anything
   listed as "Not yet told" to the user first.
3. Continue with Next actions, within Ownership. Do not resume the parent's
   unrelated work. Do not repeat a user-reported failed command just to confirm it.

Working directory: <absolute launch directory>
Repo: <root> | Branch: <branch or detached> | HEAD: <sha>
Tree: <fingerprint> (recompute: `{ git rev-parse HEAD; git status --porcelain; git diff HEAD; } | shasum | cut -c1-12`)

## Follow-up from the user
<exact request and resolved meaning of references; takes priority over Next actions>

## Mission
<done-state, 1–3 sentences>

## Ownership
<continuation: successor owns remaining work; parent stops>
<focused session: exact scope, read-only or authorized changes, what stays with parent>

## User
- <user choices, constraints, preferences and requested output>
- Not yet told: <findings/results/caveats the user is owed>

## Current state
<what exists, what works, uncommitted changes and what remains unfinished>

## Decisions
- <decision> — <rationale>

## Verified facts
- <fact> — <file:line, observed command/result or source link>
- <inference explicitly labeled as such; how to resolve it>

## Pitfalls
- <expensive warning or failed approach> — <safe alternative>

## State outside the repo
- <running process/service, tmux pane, temp artifact or remote context> — <how to inspect it>
- <credential location or variable name only; never its value>

## Open questions
- <question> — <evidence needed>

## Next actions
1. <immediately executable step>
2. <next step>

## Verify
- <commands/scenarios that prove the requested behavior; prior results and limits>
```

Record complete durable state; trim redundancy, not necessary context. Do not
pass `agent://`, `proc://`, `artifact://` or eval variables as if they were durable
cross-session references. Materialize essential transient state into files outside
the worktree, and record their absolute paths and whether they are the only copy.
Name external processes and explicit remote contexts; never assume tool handles
or browser tabs transfer. A background command still owned by the parent is not
owned by the successor merely because it appears in the document.

## Model and thinking selection

- No explicit model: omit `--model` and use omp's configured default. No explicit
  effort: omit `--thinking`. Do not change persistent configuration or model roles.
- Parse an explicit model wherever the request puts it: "with/using/on/use X",
  or "a new X session". Separate it from the mission; do not mistake task text
  for a model. Pass the user's model phrase to the launcher. A trailing effort
  word is recognized, so `--model 'GPT 6.1 Sol High'` is valid.
- Efforts: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`.
  For an explicitly selected model, Paseo must advertise the requested option:
  do not assume that `auto` or `off` is supported just because the TUI accepts it.
- The live catalog follows the transport: `paseo provider models omp --thinking
  --json` for Paseo; `omp models --json` for tmux/manual. Exact provider/model
  selectors take priority, then exact normalized ID/name, then normalized
  substring. Spaces, dots, underscores and hyphens are equivalent; case is ignored.
- With an explicit model, the launcher checks the requested thinking level
  against that transport's catalog before creation. Without an explicit model,
  the provider uses its default and validates any supplied thinking option.
- If unavailable, do not silently substitute a model or create a default session.
  Report the blocker and saved document. For ambiguity, ask the user to choose
  among the exact selectors returned. A full selector removes ambiguity.
- Example: `GPT 6.1 Sol High` resolves to `openai-codex/gpt-6.1-sol` with
  `--thinking high` in the verified catalogs. This is an example, not an alias
  table; resolve it again at launch time.

## Launch

Find `scripts/start.mjs` beside this skill. Use its absolute path from the skill's
resolved filesystem location (tracked workstation path:
`~/.config/home-manager/omp/skills/handoff/scripts/start.mjs`). Run with absolute
handoff and working-directory paths, preserving the current checkout:

```sh
node <skill-directory>/scripts/start.mjs --file <absolute-document-path> --cwd <absolute-working-directory>
node <skill-directory>/scripts/start.mjs --file <absolute-document-path> --cwd <absolute-working-directory> --model 'GPT 6.1 Sol High'
```

These are alternatives, not two launches. `--check` validates the document,
transport and requested model/thinking without creating a pane/session.
`--thinking high` can be supplied separately.

### Transport detection

The default `--transport auto` selects:

1. **Paseo** when `PASEO_AGENT_ID` or `PASEO_WORKSPACE_ID` is present, or a bounded
   parent-process check finds `Paseo Daemon`/`Paseo Supervisor`. Native omp tools
   can omit the environment markers, so ancestry covers that case. Paseo takes
   precedence over inherited tmux variables.
2. **tmux** when `TMUX` and a valid `TMUX_PANE` are present.
3. **manual** otherwise. Installing Paseo or finding a running daemon alone
   does not turn an unrelated terminal into a Paseo session.

Use `--transport paseo|tmux|manual` only to override the detected surface when
the user requests another destination or automatic detection is unavailable.
Forced tmux still requires an explicit current pane. Never pick an arbitrary
existing user pane or create a detached replacement handoff TUI.

### Native Paseo

The launcher uses `paseo run --background --provider omp` to create a fresh
native session in the app. A local Paseo workspace record preserves the exact
requested working directory; no git branch or worktree is created. It passes
the resolved model/thinking only when requested, preserving normal provider
configuration, safety extensions, rules and skills.

The initial prompt tells the successor to read the retained document and follow
it. That prompt is submitted once as part of creation. Do not separately call
`paseo send`, import/resume the outgoing transcript, or pipe into a headless omp
process. The returned Paseo agent ID identifies a new live controller, not a
native task subagent or tmux terminal.

### tmux or manual

The launcher writes a private temporary overlay containing only
`autoResume: false`; normal safety extensions, rules, skills and model roles
remain enabled. No persistent configuration is changed.

In tmux it runs `tmux split-window -h` targeting `TMUX_PANE`, with the current
working directory and actual omp executable. `@<document>` is passed once:
omp embeds the document in a native file wrapper and submits the initial prompt.
Never use `send-keys` or submit the document again.

Manual mode creates no session. It returns `status: manual` and a shell-quoted
command for a new terminal using the same fresh-session overlay and model.
Report explicitly that no successor is running yet.

### Receipt and ownership

`status: launched` proves Paseo creation acknowledgement or tmux pane creation,
not a completed model turn. Report `transport`, the Paseo `agentId`/title or tmux
`pane`, resolved model/thinking (or configured default), and document path.
Do not invent a session UUID or claim the successor completed its task.

A visible startup error or uncertain creation receipt requires inspection of
that destination, not an automatic retry. Preserve the document and any tmux
pane or Paseo agent; a failed command may already have created a successor.
The successor owns remaining work after a successful continuation launch:
stop here. Do not wait for, poll or prompt it again. A manual command transfers
no ownership until the user starts it.

A nonzero exit always leaves the document intact. If receipt is uncertain,
stop until ownership is resolved; do not create another session or continue
editing concurrently. Keep the document and any TUI overlay after launch
because the user may need them for recovery.

Launcher regressions: `node --test <skill-directory>/scripts/start.test.mjs`.

