# Agent configuration

- This directory consumes the immutable public `tomasmota/agents` core through thin Home Manager adapters. Read `config/README.md` before changing it.
- Shared roles/descriptions/routing/portable skills are edited centrally. Workstation model maps, provider/permission/MCP/browser settings and CLI preferences are edited in `config/`; render generated snapshots with `AGENTS_SOURCE=$HOME/dev/personal/agents bash agents/config/manage.sh --render` from the repository root.
- `AGENTS_SOURCE` must point at a clean central checkout of `tomasmota/agents` at the locked SHA; the only such clone on this machine is `~/dev/personal/agents`. The script's default (`$(dirname root)/agents`) does not exist here, so always pass it explicitly rather than probing for the checkout.
- Shared base behavior and instruction/skill ownership heuristics are canonical in central `config/instructions.md`; consult `config/README.md` here for generated versus local skill paths. Do not reintroduce shared workflow copies into `config/platform.md`.
- Generated routes hot-reload, but do not edit them directly. Changing an exact package pin requires target reconciliation and active-identity proof.

## Sources of truth

- Central lock and adapters: `config/lock.json`, `config/mac.json`, `config/platform.*` (Mac-only; there is no Linux OpenCode profile)
- CLI preference source: `config/cli.json`; generated `opencode/cli.json`
- Local quota/credential adapter: `opencode/plugins/agent-routes/quota.js`
- Generated recovery artifacts: `opencode/opencode*.json`, `opencode/subagents.jsonc`, shared helpers/skills, `global/AGENTS.md`, `config/inventory.*.json`
- Runtime/Nix integration: `runtime/`, `../agents.nix`, `../darwin/cliproxyapi.nix`

## OpenCode documentation

- Before adding or changing OpenCode configuration fields, load the OpenCode skill and consult the linked V2 documentation. Do not guess field names or syntax, and do not rely on V1 documentation or the published schema to infer V2 behavior.

## Model references

- Before setting an OpenCode model, use the available OpenCode models listing tool and copy the exact `providerID/modelID` it returns. Do not infer or normalize model IDs.
- A colon may be part of the literal model ID, such as `inco/glm-5.3-flash:fast`; preserve it exactly.
- Append `#variant` only when the models listing exposes that variant for the selected model. Never convert a colon suffix in a model ID into a `#variant`.
- After rendering an adapter model change, check `~/.cache/opencode/agent-routes.json`: `errors` must be empty and the primary mapping must match.

## Checks

There is no local test suite; central plugins are tested in the canonical repository.

- After any render: `node agents/config/check.mjs`, then confirm `~/.cache/opencode/agent-routes.json` has empty `errors` and the expected mapping.
- Structural edits (render/`manage.sh`/`check.mjs` logic, runtime, Nix, activation): also `AGENTS_SOURCE=$HOME/dev/personal/agents bash agents/config/manage.sh --check` and `darwin-rebuild build --flake .#macbook`.
