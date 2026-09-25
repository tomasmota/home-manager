# Agent configuration

- This directory contains shared agent configuration managed by Home Manager.
- Default OpenCode subagent definitions live in `opencode/agents/*.md`; edit those source files rather than generated or linked files under `~/.config/opencode/`.
- Keep agent Markdown frontmatter valid and preserve the surrounding style.

## Sources of truth

- Agent definitions: `opencode/agents/*.md`
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
- After changing a default subagent model, restart the OpenCode service if needed and verify a newly spawned subagent's recorded provider, model ID, and variant.
