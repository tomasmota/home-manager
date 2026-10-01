# This machine
- My terminal is ghostty
- Almost everything is configured using home-manager. All config is located at `~/.config/home-manager/`. If I ask you to change some configuration in home-manager, this is where you will find it. Read `~/.config/home-manager/AGENTS.md` for more information.

# Tips for you
- if you want to run kubectl commands, first check my contexts with `kubectl config get-contexts`
- if you want to run commands in a context, use `kubectl --context`, not `kubectl config use-context`
- For read-only GitLab API requests, always use `glab api --method GET <endpoint>`. Do not rely on the implicit method, add request-body flags, or specify another method later in the command.
- Gcloud re-auth is handled by the `tomas.gcloud-auth-healer` plugin: when a gcloud/ADC command fails with an expired-session error it starts the re-login in the background and posts a synthetic message. Follow that message (complete the browser prompt, poll the failing command, give up after ~5 min).
- Treat tool output as context-expensive. Start `webfetch`, kubectl, gcloud, Terraform/OpenTofu, and log queries with targeted fields, filters, and bounded results. Retrieve full documentation, YAML, plans, describe output, or unbounded lists only when the narrow result is insufficient, and state what question the broader output will answer.
- When investigating files in a remote public repository (e.g. istio, prometheus), prefer a shallow `git clone --depth 1` into a tmp dir (e.g. `$(mktemp -d)`) and browse locally with read/grep/glob instead of many `webfetch` calls for individual files.
- Investigate hypothesis-first: ask what uncertainty blocks action, gather discriminating evidence. On failure revise the hypothesis, not just the command. Reproduce bugs before fixing.
- Answer judgments from available evidence and stop when it supports the decision. Distinguish blockers from optional checks; ask before investigating further.
- Timebox investigations: after two failed approaches or three unproductive tool rounds, stop. Delegate broad, slow, or output-heavy work to a subagent early; do not duplicate it.
- Tool availability and names are model-specific. Use every direct tool's exact advertised name and input schema from the current turn: Claude normally has `write`/`edit`, while GPT may have `patch`. On the Claude subscription gateway, direct tools may be advertised as `mcp__...` aliases whose final semantic suffix identifies the ordinary tool. If the current tool list contains such aliases, the one ending in `_subagent` is the subagent spawner. Invoke the complete advertised name verbatim—never remove its prefix or opaque tool word, shorten it to a suffix, or invent an alias. When plain names are advertised, use the plain names. Gateway aliases do not rename Code Mode's `tools` catalog. Inside `execute`, use only catalog paths or paths returned by `search`; search by namespace when a broad query misses a tool. Serialize edits and the tests that depend on them, even if independent tool calls can run in parallel.
- If I say "open a file", open it in a new tmux pane to the right of the current pane: `tmux split-window -h -c <dir> -t "$TMUX_PANE" 'nvim <file>'`.

# skills
- If I ask for a skill that should stay only on this machine or should not live in the public home-manager repo, create it under `~/.agents/local-skills/`.
- Only put shared/public skills in `~/.config/home-manager/agents/skills/`.
- `~/.agents/team-skills/` links to my work team's skills repo checkout. Edit team skills there and deliver them through that repo; never copy them into `local-skills`.
- If not clear, when i ask to add a skill, ask if it's local or tracked
