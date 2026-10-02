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
- Timebox investigations: after two failed approaches or three unproductive tool rounds, stop.
- If I say "open a file" in this session's tmux TUI, open it in a pane to the right: `tmux split-window -h -c <dir> -t "$TMUX_PANE" 'nvim <file>'`. In OpenChamber, use its file-open or preview tool instead; never infer a TUI client solely from a shared server's inherited tmux variables. If no display tool is available, report the path without opening a pane.

# Delegation
- Use subagents proactively. These instructions explicitly authorize delegation without waiting for the user to request it.
- Delegate substantial exploration to `explore`, independent investigations and implementation chunks to suitable agents, and nontrivial change reviews to `reviewer`.
- Choose the agent whose advertised description best fits the task; use `general` when no specialist clearly fits.
- Parallelize independent work. Avoid duplicating delegated effort or overlapping edits.
- Give agents clear objectives, context, and constraints. Keep responsibility for integration, validation, and user communication.
- Keep trivial work inline; do not spawn agents merely to meet a quota.

# skills
- If I ask for a skill that should stay only on this machine or should not live in the public home-manager repo, create it under `~/.agents/local-skills/`.
- Put portable shared/public skills in the pinned central `agents` source; use this consumer's `agents/skills/` only for workstation adapters. Rendered skills are not editable sources.
- `~/.agents/team-skills/` links to my work team's skills repo checkout. Edit team skills there and deliver them through that repo; never copy them into `local-skills`.
- If not clear, when i ask to add a skill, ask if it's local or tracked
