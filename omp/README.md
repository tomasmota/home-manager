# Oh My Pi (omp)

Mac-only, self-contained: `default.nix` is the whole Home Manager module and
nothing here depends on OpenCode or `agents/`. The flake input is pinned in
`flake.nix`; update deliberately with `nix flake update omp`.

| File | Installed as | Notes |
| --- | --- | --- |
| `default.nix` `policy` | `~/.omp/agent/config.yml` | reapplied on every switch |
| `default.nix` `preferences` | `~/.omp/agent/config.yml` | seed only; live edits win (`merge-config.sh`) |
| `default.nix` `models` | `~/.omp/agent/models.yml` | Inco custom provider |
| `AGENTS.md` | `~/.omp/agent/AGENTS.md` | user context; shadows `~/.agents/AGENTS.md` |
| `RULES.md` | `~/.omp/agent/RULES.md` | sticky MCP safety rule |
| `mcp.json` | `~/.omp/agent/mcp.json` | writable 0600 copy, reset on switch |
| `mcp-policy.ts` | extension | Confluence allow-list, Chrome denies; hides denied tools from context |
| `jev/` | extension | Jev permission review before the native `yolo` gate |
| `status-line.ts` | extension | `ctx used/window` and accumulated Inco cost in the status line |
| `skills/` | skill dir | read live from the repo; `ste` = ASD-STE100 replies, `handoff` = fresh omp sessions |

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
launcher starts a fresh full omp TUI in a right-hand tmux pane and submits the
document once. A per-launch overlay disables auto-resume without changing live
settings or disabling safety extensions. Continuation transfers ownership;
a focused investigation carries only its own scope.

Explicit models resolve against `omp models --json`, with supported thinking
levels checked before launch. Without a model request, omp uses its configured default.
Unavailable/ambiguous requests never silently fall back. Outside tmux, return
a ready-to-run command instead of starting a hidden headless session.

No switch is needed: fresh processes discover the skill; existing sessions can
use `/reload-plugins` to refresh skills (and reconnect MCP servers).

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
