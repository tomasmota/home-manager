---
name: handoff-custom
description: >
  Hand off work from omp running inside the tern terminal to a fresh omp session
  in a new tern pane, or start a focused investigation there with an explicitly
  requested model and thinking level. Use for "handoff to a new agent to continue
  the work", "create a new GPT 6.1 Sol High session to investigate X", or requests
  to write a handoff document. Launching works only for omp inside tern.
license: MIT
metadata:
  runtime: omp
---

# Custom handoff to a fresh omp session in tern

Transfer durable task state through a self-contained document, not conversation
history. The successor has no access to your eval kernel, tool handles or memory.
This skill is only for omp running inside the tern terminal: it starts a fresh
interactive omp in a new tern pane beside yours. It does not create a `task`
subagent, resume a conversation or fork the outgoing session.

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
  do not run the launcher or open a tern pane. Report its path and this
  ready-to-paste prompt: `Taking over after a handoff. Read <path> and follow it.`
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
Briefs: <KEY1,KEY2, only when launched with --brief; user-owned. Their contents are not copied here>

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
- The launcher resolves the phrase against the live `omp models --json` catalog.
  Exact provider/model selectors take priority, then exact normalized ID/name,
  then normalized substring. Spaces, dots, underscores and hyphens are
  equivalent; case is ignored.
- With an explicit model, the launcher checks the effort against the levels that
  model advertises; omp accepts `auto` and `off` for every model. Without an
  explicit model, it checks only that the effort is a known level.
- If unavailable, do not silently substitute a model or create a default session.
  Report the blocker and saved document. For ambiguity, ask the user to choose
  among the exact selectors returned. A full selector removes ambiguity.
- Example: `GPT 6.1 Sol High` may resolve to `openai-codex/gpt-6.1-sol` with
  `--thinking high`. This is an example, not an alias table; resolve it at
  launch time.

## Briefs

Briefs are fixed, user-owned context for the main session (`brief` CLI; omp's
`--brief KEY1,KEY2`). The launcher only selects existing briefs; this skill never
creates, edits, restores or logs progress in them, and never copies their
contents into the document.

- **Continue the work**: pass all keys from the `<brief key="KEY">` blocks in
  your context, in order, as one comma-separated `--brief` value. Do not infer
  keys from the directory, branch, recent briefs or `brief ls`.
- **Focused/unrelated investigation**: omit `--brief`, unless the user says it
  belongs to the same task or selects briefs explicitly. When omitted, the
  successor uses its own repo default, if configured.
- **Explicit selection**: briefs named by the user replace inheritance. Without
  an explicit selection or visible brief blocks, omit the flag.
- The launcher validates every selected key before opening a pane, refusing any
  missing, archived, malformed or reserved key. Report the message; do not repair
  it or retry without that brief unless the user agrees.

## Launch

Find `scripts/start.mjs` beside this skill. Use its absolute path from the skill's
resolved filesystem location (tracked workstation path:
`~/.config/home-manager/agents/skills/handoff-custom/scripts/start.mjs`). Run it
with the bash tool, not the eval kernel: it needs the `TERN_PANE` variable that
tern sets in your pane. Use absolute document and working-directory paths,
preserving the current checkout:

```sh
node <skill-directory>/scripts/start.mjs --file <absolute-document-path> --cwd <absolute-working-directory>
node <skill-directory>/scripts/start.mjs --file <absolute-document-path> --cwd <absolute-working-directory> --model 'GPT 6.1 Sol High'
node <skill-directory>/scripts/start.mjs --file <absolute-document-path> --cwd <absolute-working-directory> --brief <KEY1,KEY2>
```

These are alternative examples, not multiple launches. Combine `--model`,
`--thinking` and `--brief` as needed; `--help` lists every option.

- `--check` validates the document, the tern pane, the working directory's
  direnv state, the model/thinking and every selected brief without exposing notes.
  It writes no files and opens no pane; `briefs` lists the selected keys.
- A launch writes a private temporary overlay config containing only
  `autoResume: false`, so omp starts a fresh session. Normal safety extensions,
  rules, skills and model roles stay enabled; no persistent configuration
  changes. Then it runs `tern split "$TERN_PANE" right --cwd <dir> --json --
  <command>` once.
- omp receives `@<document>` once as an argument and submits it as the first
  prompt. Never type into a pane to start or prompt a successor: no `tern run`,
  `tern send` or key input, and never submit the document again.
- Outside tern the launcher refuses. Save the document and report it as in
  **Document only**, stating that no successor is running.

### Environment

tern runs the command in your login shell. The launcher adds an interactive
shell, which reads the rc files (zsh sources `secrets.env` there), and
`direnv exec <dir>`, which loads the working directory's `.envrc`. The successor
gets the same PATH, secrets and direnv variables as omp typed in a new pane. If
direnv has not allowed that `.envrc`, the launcher stops before opening a pane:
report it. Only the user runs `direnv allow`.

### Receipt and ownership

`status: launched` means tern created the block and its program is this omp
invocation with the document argument. It does not prove a completed model
turn. Report the tern `block`, the resolved model/thinking (or configured
default), the selected brief keys (or repo default) and the document path. Do not invent a session
ID or claim the successor completed its task.

A nonzero exit always leaves the document intact. Follow its message:

- "No successor was started": nothing is running. Fix the cause or report it.
- A message that names a block: read it once with
  `tern capture <block> --surfaces` (omp's TUI text appears only with
  `--surfaces`) and report what it shows.
- `tern split` reported no block: check `tern ls --json` once for a new omp block.

Never retry automatically, close a successor's block or start another successor
while one may be running; the user decides. The successor owns remaining work
after a successful continuation launch: stop here. Do not wait for, poll,
capture or prompt it again. Keep the document and the overlay after launch
because the user may need them for recovery.

Launcher regressions: `node --test <skill-directory>/scripts/start.test.mjs`.
