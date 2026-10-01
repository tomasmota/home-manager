# Agent configuration

- This directory contains shared agent configuration managed by Home Manager.
- Shared OpenCode agents (general, coder, terminal, quick, deep, explore, reviewer, free) are defined in `opencode/subagents.jsonc`. The `opencode/plugins/agent-routes` server plugin turns them into agents and hot-reloads edits, so no restart or switch is needed. Edit that file rather than adding Markdown agents or generated files under `~/.config/opencode/`.
- Keep `subagents.jsonc` comments accurate and preserve its style. Agent descriptions are what delegating models read when choosing an agent, so describe when to use each one.

## Sources of truth

- Agent definitions, quota fallbacks, and shared agent permissions: `opencode/subagents.jsonc`
- Agent plugin: `opencode/plugins/agent-routes/` (shared logic in `opencode/lib/agent-routes.js`)
- OpenCode server configuration: `opencode/opencode*.json`
- OpenCode TUI configuration: `opencode/cli.json`
- Shared skills: `skills/*/SKILL.md`
- Global agent instructions: `global/AGENTS.md`

## OpenCode documentation

- Before adding or changing OpenCode configuration fields, load the OpenCode skill and consult the linked V2 documentation. Do not guess field names or syntax, and do not rely on V1 documentation or the published schema to infer V2 behavior.

## Model references

- Before setting an OpenCode model, use the available OpenCode models listing tool and copy the exact `providerID/modelID` it returns. Do not infer or normalize model IDs.
- A colon may be part of the literal model ID, such as `inco/glm-5.3-flash:fast`; preserve it exactly.
- Append `#variant` only when the models listing exposes that variant for the selected model. Never convert a colon suffix in a model ID into a `#variant`.
- After changing an agent model in `subagents.jsonc`, check `~/.cache/opencode/agent-routes.json`: `errors` must be empty and `agents.<id>.model` must show the new model. Invalid edits are logged to `~/.local/share/opencode/log/agent-routes.log`, and the last good version stays active.

## Tests

- Run `node --test opencode/tests/*.test.mjs` after changing the plugin, `opencode/lib/`, `subagents.jsonc`, or the model-selector script.
