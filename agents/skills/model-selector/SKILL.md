---
name: model-selector
description: Select an OpenCode model and reasoning effort for a new work session. Use when a handoff has no explicit model, or when the user asks to choose a model automatically.
license: MIT
---

# Model Selector

Use this only to choose a model for a new session. The user's explicit model and effort always win.

## Select

1. Assemble a compact factual brief of the remaining work: requested outcome, plan status, unresolved decisions, prior failed attempts, expected breadth, and verification. For a handoff, use the drafted document's Mission, Open questions, Next actions, and Verify, not the whole document: the selector keeps only the first 8,000 characters. Do not include raw logs or the whole conversation.
2. Pipe the brief to the selector. It makes one Jev Choice request with a 3-second timeout:

```bash
node ~/.agents/skills/model-selector/scripts/select.mjs <<'EOF'
<compact factual brief>
EOF
```

3. Parse its one-line JSON result (`agent`, `model`, optional `effort`, optional `fallbackFrom`). Report the agent, model, and effort in one short sentence. Do not put it in the handoff document.

To resolve a named agent without Jev, run `node ~/.agents/skills/model-selector/scripts/select.mjs --agent <name>`. It prints the same JSON shape.

## Agents

The candidates are the agents with `mode: "all"` in `~/.config/home-manager/agents/opencode/subagents.jsonc`, and their descriptions are the selection criteria. Change agents, models, or descriptions there, not in this skill.

Each result uses the model the agent-routes plugin currently assigns that agent, after quota and availability fallbacks (read from `~/.cache/opencode/agent-routes.json`). When that state is stale or missing, the configured model is used. If Jev is unavailable, the selector returns `general`.
