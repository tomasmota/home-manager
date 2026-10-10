# Oh My Pi (omp)

Mac-only: `default.nix` owns native omp configuration. Shared user instructions
and public skills are locally owned alongside it in `../global/` and `../skills/`.
The flake input follows upstream; `flake.lock` fixes the installed revision.
Run commands below from the checkout root. Update only omp with
`nix flake update omp`, or all inputs (including omp) with `nix flake update`.
Apply with `sudo darwin-rebuild switch --flake .#macbook`, then start a fresh omp
process. Installed `~/.omp/agent/` and shared `~/.agents/` paths stay unchanged.

| File | Installed as | Notes |
| --- | --- | --- |
| `default.nix` `policy` | `~/.omp/agent/config.yml` | reapplied on every switch |
| `default.nix` `preferences` | `~/.omp/agent/config.yml` | seed only; live edits win (`merge-config.sh`) |
| `default.nix` `models` | `~/.omp/agent/models.yml` | Inco custom provider |
| `../global/AGENTS.md` | `~/.agents/AGENTS.md` | standard shared user context, linked by `../../agents.nix` |
| `RULES.md` | `~/.omp/agent/RULES.md` | sticky MCP safety rule |
| `mcp.json` | `~/.omp/agent/mcp.json` | writable 0600 copy, reset on switch |
| `google-developer-knowledge.mjs` | `~/.omp/agent/google-developer-knowledge.mjs` | live symlink; stdio-to-HTTP bridge with user ADC renewal |
| `mcp-policy.ts` | extension | Confluence allow-list and Chrome denies enforced at `tool_call`; no active-tool pruning |
| `jev/` | extension | Jev permission review before the native `yolo` gate |
| `jev/tmux-title.ts` | extension | Jev-powered `<repo>:<task>` tmux window names |
| `jev/tmux-status.ts` | extension | tmux tab state, timers, bells and Jev completion classification |
| `status-line.ts` | extension | `ctx used/window` and accumulated Inco cost in the status line |
| `../skills/` | `~/.agents/skills/` | locally owned public skills; `ste`, `handoff` and `tmux-control` included |

Skills use standard shared `~/.agents/skills` discovery, enabled by default and
explicitly enabled by policy. Only private `~/.agents/local-skills` and
`~/.agents/team-skills` need extra directories; neither is copied into this
public repo. Agents: the bundled `task`, `scout`, `sonic` and `security-reviewer`;
`deep` (`agents/deep.md`) uses the `@slow` role. Model roles, fallback chains
and per-agent model overrides are runtime-owned: set them with `/model`,
`/agents` or `omp config set`; Nix never writes them.

The `agents` discovery provider loads `~/.agents/AGENTS.md` at user scope.
Native `~/.omp/agent/AGENTS.md` has higher priority and would shadow it, so the
module deliberately installs no native user context file. Remove an old native
shadow and old native `skills/tmux-control` link during the cutover; Home Manager
removes managed links when the former declarations disappear.
The short `RULES.md` remains at `~/.omp/agent/RULES.md`: native top-level rules
are always-apply sticky content, unlike ordinary opening context. A shared
`~/.agents/RULES.md` would not supply that behavior. Named profiles relocate
native user state, so they need their own native safety configuration if used.
These paths/defaults were also inspected in the installed omp 18.8.6 executable.
Discovery semantics: [pinned omp context-file guide](https://github.com/can1357/oh-my-pi/blob/579da1d661c5cb8d43bc2ddd429ab72e67165ad8/docs/context-files.md).

## Handoff

`../skills/handoff/` starts fresh native omp sessions. Say:

- “Handoff to a new agent to continue the work.”
- “Create a new GPT 6.1 Sol High session to investigate X.”
- “Write a handoff document.” (save only; no new session)

The skill writes a self-contained snapshot outside the worktree. Its Node
launcher detects Paseo from context markers or daemon ancestry and creates a
fresh native omp session in the app. In tmux it opens a full omp TUI in a
right-hand pane, with an overlay disabling auto-resume. Otherwise it returns
a ready-to-run manual command; it never starts a hidden replacement TUI.
`--transport paseo|tmux|manual` can override detection. Normal safety extensions
remain enabled, and the handoff is submitted once. Continuation transfers
ownership; a focused investigation carries only its own scope.

Explicit models and thinking resolve against the selected transport's live
catalog: Paseo's omp provider or `omp models --json`. Without a model request,
omp uses its configured default. Unavailable/ambiguous requests never silently
fall back. Regressions: `node --test agents/skills/handoff/scripts/start.test.mjs`.

No switch is needed: fresh processes discover the skill; existing sessions can
use `/reload-plugins` to refresh skills (and reconnect MCP servers).

## tmux control: CLI/TUI testing and debugging

The [`tmux-control` skill](https://github.com/tomasmota/agents/blob/27519890c40e04efcb5676640f378e0c9f6fbbde/skills/tmux-control/SKILL.md)
is vendored locally at `../skills/tmux-control/SKILL.md` from upstream
revision `27519890c40e04efcb5676640f378e0c9f6fbbde` (MIT). Its imported SHA-256
is `PssVuBe0f3zPKGyuTWGksCz+h6v9aHTVdcCTuupA1HA=`.
No network fetch, separate native skill install or duplicate discovery is needed.

Discover it with requests such as:

- “Test this interactive CLI in a real terminal.”
- “Debug this TUI's startup failure and keyboard navigation using tmux.”
- “Exercise this REPL and inspect its output and exit status.”

It covers explicit server/pane IDs, isolated PTYs, bounded readiness checks,
literal input versus keys, multiline paste hazards, scrollback/process/exit
inspection and cleanup restricted to task-owned resources. The Python REPL
example was exercised on tmux 3.7c: result `42`, `ZeroDivisionError`, normal exit
status `0`, bad-option startup status `2`, and removal of the private test server.
This is terminal text evidence, not verification of another TUI's visuals.

Edit this local source directly. For an upstream update, import the chosen
revision and preserve provenance/license information here; no external checkout,
render or lock update is required. Fresh omp processes discover the shared
skill, or use `/reload-plugins` in an existing session. Check discovery without
a model call with `omp read skill://tmux-control`.

## Credentials

OAuth and TypeSafe credentials live in omp's own `~/.omp/agent/agent.db`:

```sh
omp login anthropic      # or /login inside a session
omp login openai-codex
omp login typesafe       # Jev review; also the judge role if you set one
```

Inco reads `INCO_API_KEY` from `secrets.env`. Jev review falls back to
`TYPESAFE_API_KEY` there.

## Google Developer Knowledge MCP

`mcp.json` registers Google's hosted documentation server through the local
`google-developer-knowledge.mjs` bridge. It exposes `search_documents`,
`get_documents`, and `answer_query`; it does not manage cloud resources.
See [Google's setup documentation](https://developers.google.com/knowledge/mcp).

The bridge uses existing **user ADC**, not an API key or omp's model-provider
credentials. It reads `GOOGLE_APPLICATION_CREDENTIALS` when set; otherwise it
reads `application_default_credentials.json` under `CLOUDSDK_CONFIG` or
`~/.config/gcloud`. Only `authorized_user` credentials are supported.
The private file `~/.omp/agent/google-developer-knowledge-project` fixes the
project for `X-Goog-User-Project`. The bridge does not use the ADC quota project.
The fixed project must have `developerknowledge.googleapis.com` enabled.
The project name stays outside the public repository and the Nix store.

For a fresh workstation:

```sh
gcloud auth application-default login
printf '%s\n' PROJECT_ID > "$HOME/.omp/agent/google-developer-knowledge-project"
gcloud services enable developerknowledge.googleapis.com --project=PROJECT_ID
```

Node is the bridge's only runtime dependency. OAuth access tokens remain in
memory and renew one minute before expiry; no credentials are copied into the
repository, Nix store, or omp credential database. After editing the config, use
`/mcp reload`, then `/mcp test google-developer-knowledge`.
After a change to ADC or the fixed project, use
`/mcp reconnect google-developer-knowledge` to read the files again.

## Runtime settings

`preferences` only seed missing keys; the live `config.yml` is authoritative.
Change `preferences` only to alter fresh-machine defaults.

## tmux window names

The main omp TUI names its containing window `<repo>:<task>` through Jev.
This extension reads only omp sessions; it does not listen to other agents.
`jev/tmux-title-core.js` was vendored from `tomasmota/agents` revision
`83972c78b953e97e37c66b8c6e3d6a600cef680e`; omp owns this independent copy
and reuses the local `jev-client.js`.

Initial, renamed, resumed and switched sessions get a short branch-like name.
After a completed user turn, Jev changes the name only when the current one
badly describes the actual work. Incidental tests, commits and follow-ups
should keep an adequate name. A failed review keeps the existing name;
initial naming falls back to a deterministic candidate if Jev is unavailable.
Git worktrees use the main repository's name.

Only the main TUI writes to `TMUX_PANE`: subagents, print/RPC modes and
processes outside tmux do nothing. Title changes are checked every 500 ms,
but unchanged ticks never call Jev. Switching sessions or starting another
turn invalidates older in-flight results.

Naming uses `TYPESAFE_API_KEY`, otherwise loads the workstation `secrets.env`.
All naming settings are omp-specific; other agents' settings are ignored.

| Variable | Default |
| --- | --- |
| `OMP_TMUX_TITLE_JEV_MODEL` | `jev-latest` |
| `OMP_TMUX_TITLE_TIMEOUT_MS` | `5000` |
| `OMP_TMUX_TITLE_UPDATE_MIN` | `0.8` |
| `OMP_TMUX_TITLE_SECRETS_FILE` | `$HOME/.config/home-manager/secrets.env` |

Start a fresh omp process after activation; `/reload-plugins` does not reload
extensions. Regression checks: `node --test agents/omp/jev/tmux-title.test.mjs`.

## tmux tab status

`jev/tmux-status.ts` adapts native omp events to the independent controller in
`jev/tmux-status-core.js`. Its `@omp_*` window and pane options are the
tmux wire contract consumed by `../../tmux.nix`. Uppercase split hotkeys `V` and
`S` launch omp in the current pane's working directory.

Only the main TUI owns its pane. Subagents, print/RPC modes and processes
outside tmux do nothing. A prompt reports `working` with an elapsed timer;
`ask` dialogs and native permission prompts report `waiting` until every
outstanding prompt resolves. Automatic continuations/retries keep the original
timer and do not report completion. Successful terminal turns report `done`
with a fixed duration, native terminal errors report `error`, and cancellation
returns to `idle`. Recoverable tool failures are not terminal errors.

After a completed turn, Jev classifies the latest user request and final
assistant text. Confident required-input outcomes become `waiting`; unresolved
failures or off-track results become `error`. Clean or uncertain results stay
`done`. Classification is **on by default**.
`dry-run` records verdicts without changing completion state; `off` makes no
classification requests. Missing credentials, unavailable Jev and malformed
results retain normal completion behavior.

Classification is asynchronous and cannot block native event handling.
New activity, session changes and shutdown invalidate older results. Split
panes aggregate by priority (`error`, `waiting`, `done`, `working`, `idle`).
Background completion/attention rings a cooldown-limited terminal bell;
visible windows do not ring. Existing tmux focus hooks acknowledge completed
alerts, and shutdown clears only the owning pane's state.

Jev uses `TYPESAFE_API_KEY`, otherwise the workstation `secrets.env`. Its
classification settings are omp-specific.

| Variable | Default |
| --- | --- |
| `OMP_JEV_ATTENTION_MODE` | `on` (`on`, `dry-run`, `off`) |
| `OMP_JEV_ATTENTION_MODEL` | `jev-latest` |
| `OMP_JEV_ATTENTION_TIMEOUT_MS` | `5000` |
| `OMP_JEV_ATTENTION_NEEDS_MIN` | `0.8` |
| `OMP_JEV_ATTENTION_COMPLETED_MAX` | `0.3` |
| `OMP_JEV_ATTENTION_CONFIDENCE_MIN` | `0.5` |
| `OMP_JEV_ATTENTION_DEBOUNCE_MS` | `150` |
| `OMP_JEV_ATTENTION_COOLDOWN_MS` | `2000` |
| `OMP_JEV_ATTENTION_SECRETS_FILE` | `$HOME/.config/home-manager/secrets.env` |

Bounded decision/failure records live in
`${XDG_STATE_HOME:-$HOME/.local/state}/omp/jev-attention/decisions.jsonl`.
Records include scores and transcript sizes, not transcript text or credentials;
late verdicts are marked stale and never applied.

New extension modules must be Git-tracked before rebuilding (`git add` is
sufficient; a commit is not required). `default.nix` checks that every required
Jev module exists in the flake snapshot, rejecting incomplete bundles during
evaluation rather than leaving a missing-module warning for omp startup.

Apply with `sudo darwin-rebuild switch --flake .#macbook`, then start a fresh
omp process. Do not use `--flake path:.` here: it can copy gitignored files,
including `secrets.env`, into the Nix store. Running sessions and
`/reload-plugins` do not load a new extension. Regression checks:
`node --test agents/omp/jev/tmux-status-core.test.mjs agents/omp/jev/tmux-status.test.mjs`.

## Permission review

`jev/permission-review.js`, `jev-client.js` and `decision-audit.js` are locally
owned reviewer modules; edit them here. Read-only tools and `task` spawns skip
review; everything else is scored by Jev, with `openai-codex/gpt-5.6-luna` then
`inco/glm-5.3-flash:fast` as direct omp-provider fallbacks. Knobs are the
`OMP_JEV_*` environment variables documented at the top of `permission-review.js`
(exhaustion default: allow). `OMP_SECRETS_FILE` overrides the secret-file fallback;
`OMP_REVIEW_DIR` overrides the reviewed project directory. Opt-in permission
audits default to `${XDG_STATE_HOME:-$HOME/.local/state}/omp/jev-auto-approve/decisions.jsonl`.
Subagents inherit the
extensions but always run `yolo`; if an extension fails to load, its review is
absent, so check startup warnings after changing extension code. Extension
changes need a new omp process, not `/reload-plugins`.

MCP policy leaves denied tools mounted and visible in context, accepting that
overhead to avoid repeated mount/unmount notices at prompt and turn boundaries.
Calls are still blocked, including unknown Confluence tools. Initial MCP
discovery can still emit a mount notice.

The Confluence allow-list includes `createConfluencePage` and
`getContentFormatGuide`. For HTML/default page bodies, fetch the format guide
before creating the page.

## Android access with Paseo

The Mac-only service in `darwin/paseo.nix` uses Paseo's native omp `rpc-ui`
provider with this same profile, extensions, credentials, skills and MCP config.
See [`../../darwin/paseo/README.md`](../../darwin/paseo/README.md) for secure direct
Android connection over Tailscale, service management and the tested limitations.

Paseo does **not** attach to a running omp TUI. Finish or interrupt the turn and
exit omp before importing its transcript. Archive the Paseo agent before resuming
that transcript in the TUI; Stop only interrupts a turn, it does not release the
process. An overlapping writer silently forks a stale conversation rather than
sharing the live agent. No global single-process restriction is installed.
