# This machine
- My terminal is ghostty
- Almost everything is configured using home-manager. All config is located at `~/.config/home-manager/`. If I ask you to change some configuration in home-manager, this is where you will find it. Read `~/.config/home-manager/AGENTS.md` for more information.

# Tips for you
- if you want to run kubectl commands, first check my contexts with `kubectl config get-contexts`
- if you want to run commands in a context, use `kubectl --context`, not `kubectl config use-context`
- For read-only GitLab API requests, always use `glab api --method GET <endpoint>`. Do not rely on the implicit method, add request-body flags, or specify another method later in the command.
- Treat tool output as context-expensive. Start `webfetch`, kubectl, gcloud, Terraform/OpenTofu, and log queries with targeted fields, filters, and bounded results. Retrieve full documentation, YAML, plans, describe output, or unbounded lists only when the narrow result is insufficient, and state what question the broader output will answer.
- When investigating files in a remote public repository (e.g. istio, prometheus), prefer a shallow `git clone --depth 1` into a tmp dir (e.g. `$(mktemp -d)`) and browse locally with read/grep/glob instead of many `webfetch` calls for individual files.
- Investigate hypothesis-first: ask what uncertainty blocks action, gather discriminating evidence. On failure revise the hypothesis, not just the command. Reproduce bugs before fixing.
- If `HANDOFF.md` exists in the worktree, trust it only when its recorded worktree/branch match and its `Base:` sha equals `git rev-parse HEAD` (see handoff skill); a file failing this is stale — delete it. Verify fresh contents against the repository's actual state before acting.
- Before ending a session or changing phase on multi-step work, write or update `HANDOFF.md` following the handoff skill.
- If I say "open a file", open it in a new tmux pane to the right of the current pane: `tmux split-window -h -c <dir> -t "$TMUX_PANE" 'nvim <file>'`.

# skills
- If I ask for a skill that should stay only on this machine or should not live in the public home-manager repo, create it under `~/.agents/local-skills/`.
- Only put shared/public skills in `~/.config/home-manager/agents/skills/`.
- If not clear, when i ask to add a skill, ask if it's local or tracked

