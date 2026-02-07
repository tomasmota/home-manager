---
name: command-policy-bootstrap
description: Add least-privilege policies for a new CLI command across OpenCode and Gemini by allowing safe reads, denying dangerous operations, and asking for everything else.
metadata:
  audience: maintainers
  scope: agent-policies
  targets: opencode-and-gemini
---

## What I do
- Create or update policy rules for a command in both OpenCode and Gemini.
- Keep policy posture least-privilege: allow safe read-only commands, deny clearly destructive commands, ask for all remaining actions.
- Preserve existing repo style and keep Linux and macOS OpenCode configs in sync.

## When to use me
Use this skill when asked to add policy support for a new command (for example `tofu`, `helm`, `kubectl`, or `gcloud` sub-tools).

## Files to update
- OpenCode: `agents/opencode/opencode.json`
- OpenCode (macOS): `agents/opencode/opencode.macos.json`
- Gemini: `agents/gemini/policies/<command>.toml`

## Policy model
1. `allow` only read-only and introspection commands.
2. `deny` only clearly dangerous or destructive commands.
3. `ask` for all other commands, including unknown or mutating operations.

## OpenCode rule strategy
- Add command-specific `bash` patterns in both OpenCode config files.
- Use wildcard patterns and rely on OpenCode precedence where the last matching rule wins.
- Put the broad fallback first, then specific `allow` rules, then specific `deny` rules.

Template:

```json
"<command>*": "ask",
"<command> help*": "allow",
"<command> version*": "allow",
"<command> list*": "allow",
"<command> get*": "allow",
"<command> describe*": "allow",
"<command> status*": "allow",
"<command> delete*": "deny",
"<command> destroy*": "deny",
"<command> purge*": "deny",
"<command> uninstall*": "deny"
```

## Gemini rule strategy
- Use one TOML policy file per command: `agents/gemini/policies/<command>.toml`.
- Keep three layers with explicit priorities:
  - Catch-all `ask_user` at low priority
  - Specific `allow` list at high priority
  - Specific `deny` list at highest priority

Template:

```toml
[[rule]]
toolName = "run_shell_command"
commandPrefix = ["<command>"]
decision = "ask_user"
priority = 100

[[rule]]
toolName = "run_shell_command"
commandPrefix = [
  "<command> help",
  "<command> version",
  "<command> list",
  "<command> get",
  "<command> describe",
  "<command> status"
]
decision = "allow"
priority = 900

[[rule]]
toolName = "run_shell_command"
commandPrefix = [
  "<command> delete",
  "<command> destroy",
  "<command> purge",
  "<command> uninstall"
]
decision = "deny"
priority = 950
```

## Classification guidance
- Default unknown subcommands to `ask`.
- Keep `allow` limited to commands that do not change remote state.
- Keep `deny` limited to high-blast-radius actions.
- Mutating but non-destructive actions should stay `ask` unless explicitly directed otherwise.

## tofu example guidance
- Likely `allow`: `tofu version`, `tofu validate`, `tofu show`, `tofu output`, `tofu state list`.
- Likely `ask`: `tofu init`, `tofu plan`, `tofu import`, `tofu taint`, `tofu untaint`, `tofu workspace *`.
- Likely `deny`: `tofu apply`, `tofu destroy`, `tofu state rm`, `tofu force-unlock`.

## Output requirements
- Explain why each allow/ask/deny group was chosen.
- Call out any behavior that changes security posture.
- Confirm edits were applied to both OpenCode config files and the Gemini policy file.
