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
- When investigating files in a remote public repository (e.g. istio, prometheus), prefer a shallow `git clone --depth 1` into a tmp dir (e.g. `$(mktemp -d)`) and browse locally with read/grep/glob instead of many `webfetch` calls for individual files.
- For multi-step infrastructure work or investigations, keep durable, worktree-local notes in `findings.md` (or the repository's established equivalent). Read them before repeating broad research. Record verified facts, decisions, key commands/results, links to primary evidence, and unresolved questions; do not record secrets. Before compaction or a phase change, update these notes so a new session can continue without relying on raw prior context. If the notes are not an established tracked repository artifact, add them to the worktree's local Git exclude file before writing them.
- Use subagents aggressively for tasks whose intermediate work is not useful to the implementation context: documentation research, codebase discovery, cloud-resource inventory, incident/log investigation, and comparison of alternative approaches. Return conclusions, evidence pointers, and unresolved questions rather than raw research output.
- Delegate bounded questions, not vague areas: give each subagent a distinct objective, boundaries, and expected output with evidence. Parallelize independent uncertainties, serialize dependencies. Prefer 2-4 purposefully different workers over swarming.
- Parent remains the decision-maker: evaluate findings, reconcile contradictions, decide if more investigation is warranted, integrate results, and own final correctness. Workers provide evidence, not truth.
- Require fresh-context review for meaningful changes: reviewer hunts for missed requirements, wrong assumptions, edge cases, regressions, and security issues, not just "looks good?".
- Stop when evidence suffices for a low-regret decision. Continue only on conflicting evidence, high consequences, or an unverified central assumption.
- Investigate hypothesis-first: ask what uncertainty blocks action, gather discriminating evidence. On failure revise the hypothesis, not just the command. Reproduce bugs before fixing.
- Scale effort to risk: trivial -> execute, complex/uncertain -> explore -> plan -> execute -> review -> verify. Cheap high-signal checks first, broaden by blast radius. Smallest coherent change that solves the real problem.

# Local-only skills
- If I ask for a skill that should stay only on this machine or should not live in the public home-manager repo, create it under `~/.agents/local-skills/`.
- Only put shared/public skills in `~/.config/home-manager/agents/skills/`.

# Git
- never commit or push changes for me unless explicitly asked to

# My preferences
- ask me as many questions as you see fit
