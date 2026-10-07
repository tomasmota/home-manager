# Oh My Pi (omp)

Mac-only, self-contained: `default.nix` is the whole Home Manager module and
nothing here depends on OpenCode or `agents/`. The flake input follows upstream;
`flake.lock` fixes the installed revision. Update only omp with
`nix flake update omp`, or all inputs (including omp) with `nix flake update`.
Apply with `sudo darwin-rebuild switch --flake .#macbook`, then start a fresh omp
process.

| File | Installed as | Notes |
| --- | --- | --- |
| `default.nix` `policy` | `~/.omp/agent/config.yml` | reapplied on every switch |
| `default.nix` `preferences` | `~/.omp/agent/config.yml` | seed only; live edits win (`merge-config.sh`) |
| `default.nix` `models` | `~/.omp/agent/models.yml` | Inco custom provider |
| `AGENTS.md` | `~/.omp/agent/AGENTS.md` | user context; shadows `~/.agents/AGENTS.md` |
| `RULES.md` | `~/.omp/agent/RULES.md` | sticky MCP safety rule |
| `mcp.json` | `~/.omp/agent/mcp.json` | writable 0600 copy, reset on switch |
| `mcp-policy.ts` | extension | Confluence allow-list and Chrome denies enforced at `tool_call`; no active-tool pruning |
| `jev/` | extension | Jev permission review before the native `yolo` gate |
| `jev/tmux-title.ts` | extension | Jev-powered `<repo>:<task>` tmux window names |
| `jev/tmux-status.ts` | extension | tmux tab state, timers, bells and Jev completion classification |
| `status-line.ts` | extension | `ctx used/window` and accumulated Inco cost in the status line |
| `skills/` | skill dir | read live from the repo; `ste` = ASD-STE100 replies, `handoff` = fresh omp sessions |
| upstream `skills/tmux-control/SKILL.md` | `~/.omp/agent/skills/tmux-control/SKILL.md` | immutable SHA + content hash in `default.nix`; independent of OpenCode |

Skills: `~/.agents/skills` (OpenCode's) is off via `skills.enableAgentsUser:
false`; the tracked `skills/` plus the private `~/.agents/local-skills` and
`~/.agents/team-skills` load. Agents: the bundled `task`, `scout`, `sonic` and `security-reviewer`;
`deep` (`agents/deep.md`) uses the `@slow` role. Model roles, fallback chains
and per-agent model overrides are runtime-owned: set them with `/model`,
`/agents` or `omp config set`; Nix never writes them.

## Handoff

`skills/handoff/` is omp-only; OpenCode's handoff skill is unchanged. Say:

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
fall back. Regressions: `node --test omp/skills/handoff/scripts/start.test.mjs`.

No switch is needed: fresh processes discover the skill; existing sessions can
use `/reload-plugins` to refresh skills (and reconnect MCP servers).

## tmux control: CLI/TUI testing and debugging

The portable [`tmux-control` skill](https://github.com/tomasmota/agents/blob/27519890c40e04efcb5676640f378e0c9f6fbbde/skills/tmux-control/SKILL.md)
is canonical in `tomasmota/agents`; `default.nix` installs only its pinned,
hash-checked file into omp's native user skill directory. OpenCode discovery
stays disabled. No plugin, daemon or tmux configuration change is needed.

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

After changing the central skill, commit/push it there, then update the immutable
URL and content hash in `default.nix`. A Home Manager switch installs the new pin;
fresh omp processes discover it, or use `/reload-plugins` in an existing session.
Check discovery without a model call with `omp read skill://tmux-control`.

## Credentials

OAuth and TypeSafe credentials live in omp's own `~/.omp/agent/agent.db`:

```sh
omp login anthropic      # or /login inside a session
omp login openai-codex
omp login typesafe       # Jev review; also the judge role if you set one
```

Inco reads `INCO_API_KEY` from `secrets.env`. Jev review falls back to
`TYPESAFE_API_KEY` there.

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
extensions. Regression checks: `node --test omp/jev/tmux-title.test.mjs`.

## tmux tab status

`jev/tmux-status.ts` adapts native omp events to the independent controller in
`jev/tmux-status-core.js`. It uses the existing `@opencode_*` window and pane
options as a shared tmux wire contract, so `../tmux.nix` needs no changes.
There is no dependency on OpenCode's runtime, plugins or settings.

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
`done`. Classification is **on by default**, unlike OpenCode's dry-run default.
`dry-run` records verdicts without changing completion state; `off` makes no
classification requests. Missing credentials, unavailable Jev and malformed
results retain normal completion behavior.

Classification is asynchronous and cannot block native event handling.
New activity, session changes and shutdown invalidate older results. Split
panes aggregate by priority (`error`, `waiting`, `done`, `working`, `idle`).
Background completion/attention rings a cooldown-limited terminal bell;
visible windows do not ring. Existing tmux focus hooks acknowledge completed
alerts, and shutdown clears only the owning pane's state.

Jev uses `TYPESAFE_API_KEY`, otherwise the workstation `secrets.env`. These
settings are omp-specific; `OPENCODE_*` settings cannot redirect classification.

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
`node --test omp/jev/tmux-status-core.test.mjs omp/jev/tmux-status.test.mjs`.

## Permission review

`jev/permission-review.js`, `jev-client.js` and `decision-audit.js` are a
vendored copy of the OpenCode reviewer in `tomasmota/agents`; edit them here.
Read-only tools and `task` spawns skip review; everything else is scored by
Jev, with `openai-codex/gpt-5.6-luna` then Inco as fallbacks. Knobs are the
`OPENCODE_JEV_*` environment variables documented at the top of
`permission-review.js` (exhaustion default: allow). Subagents inherit the
extensions but always run `yolo`; if an extension fails to load, its review is
absent, so check startup warnings after changing extension code. Extension
changes need a new omp process, not `/reload-plugins`.

MCP policy leaves denied tools mounted and visible in context, accepting that
overhead to avoid repeated mount/unmount notices at prompt and turn boundaries.
Calls are still blocked, including unknown Confluence tools. Initial MCP
discovery can still emit a mount notice.

## Android access with Paseo

The Mac-only service in `darwin/paseo.nix` uses Paseo's native omp `rpc-ui`
provider with this same profile, extensions, credentials, skills and MCP config.
See [`../darwin/paseo/README.md`](../darwin/paseo/README.md) for secure direct
Android connection over Tailscale, service management and the tested limitations.

Paseo does **not** attach to a running omp TUI. Finish or interrupt the turn and
exit omp before importing its transcript. Archive the Paseo agent before resuming
that transcript in the TUI; Stop only interrupts a turn, it does not release the
process. An overlapping writer silently forks a stale conversation rather than
sharing the live agent. No global single-process restriction is installed.
