# Oh My Pi (omp)

Mac-only: `default.nix` owns native omp configuration, including the installed
files and extensions. Shared user instructions and public skills are locally
owned alongside it in `../global/` and `../skills/`.
The flake input follows upstream; `flake.lock` fixes the installed revision.
Run commands below from the checkout root. Update only omp with
`nix flake update omp`, or all inputs (including omp) with `nix flake update`.
Apply with `sudo darwin-rebuild switch --flake .#macbook`, then start a fresh omp
process. Installed `~/.omp/agent/` and shared `~/.agents/` paths stay unchanged.

## Ownership

- `default.nix` `policy` is reapplied to `~/.omp/agent/config.yml` on every
  switch. `preferences` only seed missing keys (`merge-config.sh`); the live
  `config.yml` is authoritative, so change `preferences` only to alter
  fresh-machine defaults.
- Model roles, fallback chains and per-agent model overrides are runtime-owned:
  set them with `/model`, `/agents` or `omp config set`; Nix never writes them.
- `~/.omp/agent/mcp.json` is a writable 0600 copy, reset on every switch.
- Skills use standard shared `~/.agents/skills` discovery. Only private
  `~/.agents/local-skills` and `~/.agents/team-skills` need extra directories;
  neither is copied into this public repo.

## Context files

The `agents` discovery provider loads `~/.agents/AGENTS.md` at user scope.
Native `~/.omp/agent/AGENTS.md` has higher priority and would shadow it, so the
module deliberately installs no native user context file.
`RULES.md` stays at `~/.omp/agent/RULES.md`: native top-level rules are
always-apply sticky content, unlike ordinary opening context, and a shared
`~/.agents/RULES.md` would not supply that behavior. Named profiles relocate
native user state, so they need their own native safety configuration if used.
Discovery semantics: `docs/context-files.md` in the [upstream omp repository](https://github.com/can1357/oh-my-pi).

## Skills

Skill behavior is documented in each `SKILL.md`, not here:
[`handoff-custom`](../skills/handoff-custom/SKILL.md) starts fresh native omp
sessions, separate from omp's built-in same-session handoff;
[`tmux-control`](../skills/tmux-control/SKILL.md) drives interactive CLIs/TUIs
in tmux. `tmux-control` is vendored from the owner's `tomasmota/agents` repo
(MIT, declared in its frontmatter); edit the local copy directly and record
provenance in its commit when importing upstream again.

No switch is needed for skill edits: fresh processes discover them, and existing
sessions can use `/reload-plugins` (which also reconnects MCP servers). Check
discovery without a model call with `omp read skill://<name>`.

## Credentials

OAuth and TypeSafe credentials live in omp's own `~/.omp/agent/agent.db`:

```sh
omp login anthropic      # or /login inside a session
omp login openai-codex
omp login typesafe       # Jev review; also the judge role if you set one
```

Inco reads `INCO_API_KEY` from `secrets.env`. Jev review falls back to
`TYPESAFE_API_KEY` there.

## Inco models

`default.nix` declares the Inco provider and its model metadata. The provider's
`apiKey` is the environment variable name `INCO_API_KEY`, never a credential.
Declaring models does not select a default or change roles.

Home Manager generates `~/.omp/agent/models.yml` from this declaration. To
activate only that generated file without a privileged rebuild, run from this
checkout:

```sh
models_path=$(nix build --no-link --print-out-paths \
  '.#darwinConfigurations.macbook.config.home-manager.users.tomas.home.file.".omp/agent/models.yml".source')
ln -sfn "$models_path" "$HOME/.omp/agent/models.yml"
```

This uses the same generated Nix store file as Home Manager's normal link
activation; it does not modify `config.yml`, defaults, roles or credentials.
Start a fresh omp process to load the models. `omp models --json` lists the live
catalog without making a generation request.

## Google Developer Knowledge MCP

`mcp.json` registers Google's hosted documentation server through the local
`google-developer-knowledge.mjs` bridge. It exposes documentation tools only; it
does not manage cloud resources.
See [Google's setup documentation](https://developers.google.com/knowledge/mcp).

The bridge uses existing **user ADC** (`authorized_user` only), not an API key or
omp's model-provider credentials; credential lookup is in the bridge source.
The private file `~/.omp/agent/google-developer-knowledge-project` fixes the
project for `X-Goog-User-Project`; the ADC quota project is not used. That project
must have `developerknowledge.googleapis.com` enabled, and its name stays outside
the public repository and the Nix store.

For a fresh workstation:

```sh
gcloud auth application-default login
printf '%s\n' PROJECT_ID > "$HOME/.omp/agent/google-developer-knowledge-project"
gcloud services enable developerknowledge.googleapis.com --project=PROJECT_ID
```

Tokens stay in memory; no credentials are copied into the repository, Nix store,
or omp credential database. After editing the config, use `/mcp reload`, then
`/mcp test google-developer-knowledge`. After a change to ADC or the fixed
project, use `/mcp reconnect google-developer-knowledge` to read the files again.

## tmux integration

Two extensions drive tmux for the main omp TUI only; subagents, print/RPC modes
and processes outside tmux do nothing:

- `jev/tmux-title.ts` names the containing window `<repo>:<task>` through Jev.
  Logic: `jev/tmux-title-core.js`.
- `jev/tmux-status.ts` publishes tab state (`working`, `waiting`, `done`,
  `error`, `idle`), timers and bells, including Jev classification of completed
  turns. Logic: `jev/tmux-status-core.js`. Its `@omp_*` window and pane options
  are the wire contract consumed by `../../tmux.nix`.

Both use `TYPESAFE_API_KEY`, otherwise the workstation `secrets.env`. Their
`OMP_TMUX_TITLE_*` and `OMP_JEV_ATTENTION_*` settings are omp-specific, with
defaults and ranges in the core modules. Attention classification is on by
default; `OMP_JEV_ATTENTION_MODE=dry-run` records verdicts without applying them
and `off` makes no requests. Unavailable credentials or Jev never block normal
completion behavior. Attention decision records contain scores and transcript
sizes, not transcript text or credentials.

New extension modules must be Git-tracked before rebuilding (`git add` is
sufficient; a commit is not required). `default.nix` checks that every required
Jev module exists in the flake snapshot, rejecting incomplete bundles during
evaluation.

Apply with `sudo darwin-rebuild switch --flake .#macbook`, then start a fresh
omp process. NEVER use `--flake path:.` here: it can copy gitignored files,
including `secrets.env`, into the Nix store. Running sessions and
`/reload-plugins` do not load a new extension. Regression checks:
`node --test agents/omp/jev/tmux-title.test.mjs agents/omp/jev/tmux-status-core.test.mjs agents/omp/jev/tmux-status.test.mjs`.

## Permission review

`jev/permission-review.js`, `infra-guard.js`, `jev-client.js` and
`decision-audit.js` are locally owned reviewer modules; edit them here.
Read-only tools, `task` spawns and `write`/`edit` calls whose target is a plain
local path (or `local://`) skip review; `ssh://`, other URLs, `file:member`
forms and anything unparsable keep it. A `write xd://<tool>` that omp
re-dispatches to a registered tool (MCP tools, `lsp`, `debug`, `ast_edit`, ...)
is reviewed once, as that tool's own call; self-handled devices
(`report_issue`, `resolve`, `reject`, `propose`) and unknown devices are
reviewed as the write. Every reviewed call first meets deterministic denies
that no reviewer, threshold or outage can loosen: catastrophic commands, then
`infra-guard.js`. The guard parses bash commands
(and local shell scripts they run), eval code and executable xd:// device
arguments, seeing through `bash -c`, wrappers such as `sudo`/`env`/`xargs`,
`ssh`, `tmux send-keys` and subprocess calls. It does not inspect write/edit
content or files passed to node/python. It hard-denies:

- any non-read-only kubectl/helm/IaC/cloud/database/ssh call whose target, or
  any token of the command, is `prod`, `production` or `prd`, or a name in
  `OMP_JEV_PROTECTED_TARGETS` (comma-separated; keep internal names there,
  not in this repo);
- destructive calls (delete, destroy, uninstall, drain, `DROP TABLE`, ...)
  unless an explicit target names a non-production environment (dev, test,
  staging, sandbox, kind, ...); implicit defaults count as unknown;
- force-pushes or deletions of main/master/release/prod branches, and
  repository deletion.

Exception: a call whose every `--context`/`--cluster`/`--kube-context` exactly
matches an entry of `OMP_JEV_TRUSTED_TARGETS` (comma-separated, kept in
`secrets.env`) is never denied or reviewed, destructive calls included. This
applies only to explicit targets without a production word, and only when the
whole command is kubectl/helm/helmfile plus read filters (`grep`, `jq`, ...)
without redirects or shell expansions; it also covers commands run through
`kubectl exec`. Otherwise normal review applies. Audit:
`reasonCode: trusted_target`.

Direct `tern`, `git`, `nix`, `cd`, `ls`, `strings`, `grep` and `pgrep` bash
commands auto-allow after these hard denies, without Jev or fallback requests.
All subcommands are trusted, including ordinary Git writes and command execution
through `tern` and `nix run`; this is not a read-only rule. Bare names, absolute
paths and `~/` paths are supported, as are compound commands and pipelines
containing only these executables. Other executables, shell expansions,
redirections and wrappers such as `env` still go through normal review.
`node`, `glab`, `command`, `rm` and `ssh` are explicitly not in the trusted set,
including when chained after `cd` or another trusted command.
Guard-flagged infrastructure mutations never use this bypass. Audits label
the bypass `source: auto-allow`, `reasonCode: trusted_command`,
`jevOutcome: not_called`.

Remaining infrastructure mutations go to Jev, which also asks a
production-impact question, then to direct omp-provider fallback models
(`DEFAULT_FALLBACK_MODELS` in `permission-review.js`, overridable with
`OMP_JEV_FALLBACK_MODELS`). When reviewers are
unavailable these mutations deny regardless of `OMP_JEV_ON_EXHAUSTION`; other
actions follow it. Knobs are the `OMP_JEV_*` environment
variables documented at the top of `permission-review.js`.
`OMP_SECRETS_FILE` overrides the secret-file fallback; `OMP_REVIEW_DIR`
overrides the reviewed project directory. Permission audits are opt-in
(`OMP_JEV_DEBUG`); the default location is in `permission-review.js`.
Regression checks: `node --test agents/omp/jev/permission-review.test.mjs agents/omp/jev/auto-approve-jev.test.mjs`.
Subagents inherit the extensions but always run `yolo`; if an extension fails
to load, its review is absent, so check startup warnings after changing
extension code. Extension changes need a new omp process, not `/reload-plugins`.

MCP policy (`mcp-policy.ts`) leaves denied tools mounted and visible in context,
accepting that overhead to avoid repeated mount/unmount notices at prompt and
turn boundaries. Calls are still blocked at `tool_call`, including unknown
Confluence tools. Initial MCP discovery can still emit a mount notice.

The Confluence allow-list includes `createConfluencePage` and
`getContentFormatGuide`. For HTML/default page bodies, fetch the format guide
before creating the page.

## Android access with Paseo

The Mac-only service in `darwin/paseo.nix` uses Paseo's native omp `rpc-ui`
provider with this same profile, extensions, credentials, skills and MCP config.
See [`../../darwin/paseo/README.md`](../../darwin/paseo/README.md) for secure direct
Android connection over Tailscale, service management and limitations.

Paseo does **not** attach to a running omp TUI. Finish or interrupt the turn and
exit omp before importing its transcript. Archive the Paseo agent before resuming
that transcript in the TUI; Stop only interrupts a turn, it does not release the
process. An overlapping writer silently forks a stale conversation rather than
sharing the live agent. No global single-process restriction is installed.
