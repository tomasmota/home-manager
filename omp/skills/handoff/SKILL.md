---
name: handoff
description: >
  Transfer work to a fresh interactive omp session, or start a focused investigation
  in a new omp session with an explicitly requested model and thinking level.
  Use for "handoff to a new agent to continue the work", "create a new GPT 6.1
  Sol High session to investigate X", or requests to write a handoff document.
license: MIT
metadata:
  verified: '2026-10-06'
  runtime: omp
---

# Handoff to a fresh omp session

Transfer durable task state through a self-contained document, not conversation
history. The successor has no access to your eval kernel, tool handles or memory.
This skill starts a full interactive omp TUI, not a `task` subagent, an OpenCode
session, a resumed session or a fork of the outgoing conversation.

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

- No explicit model: omit `--model`. Use omp's configured default, not OpenCode's
  selector or a hardcoded alias. No explicit effort: omit `--thinking` and use
  omp's configured default. Do not change persistent configuration or model roles.
- Parse an explicit model wherever the request puts it: "with/using/on/use X",
  or "a new X session". Separate it from the mission; do not mistake task text
  for a model. Pass the user's model phrase to the launcher. A trailing effort
  word is recognized, so `--model 'GPT 6.1 Sol High'` is valid.
- Efforts: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`.
  OpenCode's `none` means omp's `off`; translate that wording explicitly.
- The launcher resolves against the live `omp models --json` catalog: exact
  provider/model selector first, exact normalized ID/name second, then normalized
  substring. Spaces, dots, underscores and hyphens are equivalent; case is ignored.
  It validates explicitly requested thinking against that model's catalog.
- If unavailable, do not silently substitute a model or create a default session.
  Report the blocker and saved document. For ambiguity, ask the user to choose
  among the exact selectors returned. A full selector removes ambiguity.
- Example: `GPT 6.1 Sol High` resolves to `openai-codex/gpt-6.1-sol` with
  `--thinking high` in the verified catalog. This is an example, not an alias
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

These are alternatives, not two launches. `--check` validates the document and
model without creating a pane/session. `--thinking high` can be supplied separately.

The launcher:

1. Validates everything before creating a pane. Writes a private temporary config
   overlay containing only `autoResume: false`, so runtime auto-resume cannot put
   the handoff into an old conversation. Normal safety extensions and rules,
   skills and model roles remain enabled; no persistent config is changed.
2. With both `TMUX` and `TMUX_PANE`, uses `tmux split-window -h` targeting that
   pane, with the current working directory and the actual omp executable. Passes
   `@<document>` once on the CLI. omp embeds the document in a native file wrapper
   and automatically submits it as the initial prompt in a fresh full TUI.
   Never use `send-keys`, pipe a prompt into a headless process, or submit it again.
3. Without tmux, creates no hidden/headless session. Returns `status: manual`
   and a shell-quoted command for the user to run in a new terminal, with the same
   fresh-session overlay and model. Report that no successor is running yet.

`status: launched` proves pane creation, not a completed model turn. Report the
pane ID, resolved model/thinking (or configured default), and document path.
Do not invent a session UUID or claim the successor completed its task. A visible
startup error is a failed/uncertain launch: preserve the pane and document and
report it. Do not automatically retry; inspect before creating another successor.
The successor owns remaining work after a successful continuation launch; stop
here. A manual command is not ownership transfer until the user starts it.

A nonzero exit always leaves the document intact. Report the failure and path.
If receipt is uncertain, stop work here until ownership is resolved; do not create
another session or continue editing concurrently. Keep the temporary document
and overlay after launch; the user may need them to recover.
