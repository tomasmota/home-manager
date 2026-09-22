---
name: model-selector
description: Select an OpenCode model and reasoning effort for a new work session. Use when a handoff has no explicit model, or when the user asks to choose a model automatically.
license: MIT
---

# Model Selector

Use this only to choose a model for a new session. The user's explicit model and effort always win.

## Select

1. Assemble a compact factual brief of the remaining work: requested outcome, plan status, unresolved decisions, prior failed attempts, expected breadth, and verification. Use `HANDOFF.md` when present. Do not include raw logs or the whole conversation.
2. Pipe the brief to the selector. It reads the local quota-watch cache and makes one Jev Choice request with a 3-second timeout:

```bash
node ~/.agents/skills/model-selector/scripts/select.mjs <<'EOF'
<compact factual brief>
EOF
```

3. Parse its one-line JSON result. Pass `--model "<model>#<effort>"` to OpenCode.
4. Report the selected profile and model in one short sentence. Do not put it in `HANDOFF.md`.

## Profiles

- `quick`: GLM 5.3 Flash high for small, obvious work. Treat as effectively free.
- `workhorse`: GPT 5.6 Terra medium for planned, sustained implementation.
- `workhorse-zai`: GLM 5.3 high when OpenAI quota is low.
- `deep`: GPT 6 Astra medium for genuinely hard, consequential decisions only.

The selector treats OpenAI as low when either the 5-hour remaining quota is below 20% or the weekly remaining quota is below 10%. It then excludes Terra from the candidates, while Astra remains available for hard decisions. If quota state is missing or Jev is unavailable, it falls back immediately to the appropriate workhorse.
