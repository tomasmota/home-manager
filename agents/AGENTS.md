# This machine
- My terminal is ghostty
- Almost everything is configured using home-manager. All config is located at `~/.config/home-manager/`. If I ask you to change some configuration in home-manager, this is where you will find it. Read `~/.config/home-manager/AGENTS.md` for more information.

# Tips for you
- Never bypass command-policy decisions with wrappers such as `env`, `command`, or `sh -c`, shell quoting tricks, aliases, or alternate executable paths.
- Never use tmux, scripts, subprocesses, or other indirection to run a command that would otherwise require approval. Obtain approval for the underlying command first; only then may it be run through tmux for persistence.
- if you want to run kubectl commands, first check my contexts with `kubectl config get-contexts`
- if you want to run commands in a context, use `kubectl --context`, not `kubectl config use-context`
- For read-only GitLab API requests, always use `glab api --method GET <endpoint>`. Do not rely on the implicit method, add request-body flags, or specify another method later in the command.
- Treat tool output as context-expensive. Start `webfetch`, kubectl, gcloud, Terraform/OpenTofu, and log queries with targeted fields, filters, and bounded results. Retrieve full documentation, YAML, plans, describe output, or unbounded lists only when the narrow result is insufficient, and state what question the broader output will answer.

# Local-only skills
- If I ask for a skill that should stay only on this machine or should not live in the public home-manager repo, create it under `~/.agents/local-skills/`.
- Only put shared/public skills in `~/.config/home-manager/agents/skills/`.

# Git
- never commit or push changes for me unless explicitly asked to

# My preferences
- ask me as many questions as you see fit
