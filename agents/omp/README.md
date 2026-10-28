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
  switch. `preferences` only seed missing keys (`merge-config.sh`, which holds
  omp's `config.yml.lock` while merging); the live `config.yml` is
  authoritative, so change `preferences` only to alter fresh-machine defaults.
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
Native `~/.omp/agent/RULES.md` supplies always-apply scope/authorization and tool-use rules; shared `AGENTS.md` holds machine context and skill ownership guidance.
Discovery semantics: `docs/context-files.md` in the [upstream omp repository](https://github.com/can1357/oh-my-pi).

## Skills

[`handoff-custom`](../skills/handoff-custom/SKILL.md) starts fresh native omp
sessions, separate from omp's built-in same-session handoff. Interactive terminal
testing follows the [native rules](RULES.md).

[`tern-ui`](../skills/tern-ui/SKILL.md) builds task-specific live panes with a
file-backed wait relay and confirmed direct actions; it needs no omp extension.

No switch is needed for skill edits: fresh processes discover them, and existing
sessions can use `/reload-plugins` (which also reconnects MCP servers). Check
discovery without a model call with `omp read skill://<name>`.

## Harness review

`/harness-review [time range, project, session or harness area]` reviews configuration coherence and observed use of instructions, roles/agents, skills and capabilities; use a fresh session, with the last seven days across projects as the default.
[`commands/harness-review.md`](commands/harness-review.md) is linked at `~/.omp/agent/commands/harness-review.md`; scheduling is external, unattended runs stop at the assessment, and implementation or publication requires explicit approval.

Session selection screens every eligible case before combining an outcome-independent coverage baseline with targeted deep dives.

## Credentials

OAuth and TypeSafe credentials live in omp's own `~/.omp/agent/agent.db`:

```sh
omp login anthropic      # or /login inside a session
omp login openai-codex
omp login typesafe       # optional judge role
```

Inco reads `INCO_API_KEY` from `secrets.env`.

DeepSeek is built in: set `DEEPSEEK_API_KEY` in `secrets.env` and select
`deepseek/deepseek-flash:high`. Keep its catalog pricing rather than adding flat
costs in `models.yml`, so peak/off-peak estimates remain automatic.

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

The bridge uses **user ADC** (`authorized_user` only) from
`~/.config/gcloud/application_default_credentials.json`, not an API key or omp's
model-provider credentials. It ignores workspace `GOOGLE_APPLICATION_CREDENTIALS`
and `CLOUDSDK_CONFIG` overrides so other cloud environments cannot break it.
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

## Briefs

`brief/` gives a session fixed, user-owned higher-level context: a linked Jira
epic fetched through the Jira MCP, free-form notes, or both. The epic is
additional background, never implicitly the session's current work item.

- `brief new KEY [-j EPIC] [-m TEXT]` creates one in `$XDG_DATA_HOME/briefs/`;
  the link is `jira: EPIC` front matter. `brief --help` lists `edit`, `ls`,
  `done`, `restore`, `rm` and `prune`. Each loaded brief shows the agent its
  file: agents edit it only when asked and may suggest durable additions,
  corrections or removals, never progress or current-task details. A brief whose
  front matter breaks stays loaded; the agent sees the error instead of its notes.
- `/brief KEY` replaces the selection; `/brief add KEY` attaches another,
  `/brief remove KEY` detaches one and `/brief off` unloads all. Omit KEY for a
  picker. `omp --brief KEY1,KEY2` loads several at startup; the session records
  their order (resume restores them, `/new` keeps them). Every main-agent turn
  re-reads their files into the end of the system prompt; subagents receive none.
  The status line shows all loaded keys after `` (Nerd Font bookmark).
- `brief bind KEY` sets this repo's default (stored in local Git config,
  including subdirectories); `brief bind` shows it and `brief unbind` removes it.
  Nothing is committed. An explicit `--brief` or saved session choice takes
  precedence; `/brief off` stays off across resume and `/new`.
- The `handoff-custom` launcher accepts `--brief KEY1,KEY2`, validates every
  brief before opening a pane and passes the selection to the successor.
  Continuations carry the briefs shown in the parent's prompt; otherwise the
  successor uses its repo default unless the user selects briefs explicitly.

## Infrastructure guard

- `default.nix` uses native `bash.patterns` denies for organization-wide GCP changes, project/repository deletion, credential loss and force-pushing main/master; other tools remain `yolo`.
- [`guard.ts`](guard.ts) denies mutations explicitly targeting prod (including IaC working directories); `/guard on` (default) asks before control changes, IaC applies/state edits and bulk cluster deletes, while `/guard off` allows those for this session. Resume/branch restore the recorded choice, new sessions default on, and subagents share the main session's switch but cannot approve prompts.
- This is an accident guard, not containment: it does not resolve implicit kube/gcloud targets or inspect scripts, eval subprocesses, `bash -c` or terminal keys. Keep targets explicit; new processes load extension changes.

Regression checks: `node --test agents/omp/guard.test.mjs`.

## Session reference

[`session-id.ts`](session-id.ts) makes `/sid` or `Alt+Shift+S` copy the absolute transcript path, which an agent can read directly or pass as `seance`'s `sourceSession` from any project on this machine. For a readable thread, run `omp render "<copied-path>" --plain`; the same path also works with `omp --resume`.

## MCP context

`mcp.json` excludes Chrome performance and memory tools at discovery and uses [Atlassian v2's deferred tool catalog](https://support.atlassian.com/atlassian-ai-gateway/docs/supported-tools/).
For deferred Atlassian operations, use `discover` and its indicated `executeRead`, `executeWrite` or `executeDestructive` tool; fetch `getContentFormatGuide` this way before authoring rich content.

## Android access with Tern

Tern is the omp interface on Mac and Android. See the
[Tern guide](../../darwin/tern/README.md) for shared live sessions over Tailscale,
service management and limitations.
