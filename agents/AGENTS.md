# Agent configuration

- This directory consumes the immutable public `tomasmota/agents` core through thin Home Manager adapters. Read `config/README.md` before changing it.
- Shared roles/descriptions/routing/portable skills are edited centrally. Workstation model maps, provider/permission/MCP/browser settings and CLI preferences are edited in `config/`; render generated snapshots with `bash agents/config/manage.sh --render` from the repository root.
- Generated routes hot-reload, but do not edit them directly. Changing an exact package pin requires target reconciliation and active-identity proof.

## Sources of truth

- Central lock and adapters: `config/lock.json`, `config/{mac,linux}.json`, `config/platform.*`
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
- After rendering an adapter model change, check `~/.cache/opencode/agent-routes.json`: `errors` must be empty and the primary mapping must match. Actual child executor calls are forced to Space Bunny by the central policy; richer `mode: all` primary choices stay intact.

## Tests

- Run `bash agents/config/manage.sh --check`, `node agents/config/check.mjs`, and `node --test --test-timeout=30000 agents/opencode/tests/*.test.mjs agents/config/test/*.test.mjs agents/runtime/test/*.test.mjs` from the root. Central plugins have their own tests in the canonical repository. Nix validation and target Mac smoke checks are separate.
