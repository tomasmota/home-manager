# This machine
- My terminal is ghostty
- Almost everything is configured using home-manager. All config is located at `~/.config/home-manager/`. If I ask you to change some configuration in home-manager, this is where you will find it. Read `~/.config/home-manager/AGENTS.md` for more information.

# Tips for you
- if you want to run kubectl commands, first check my contexts with `kubectl config get-contexts`
- if you want to run commands in a context, use `kubectl --context`, not `kubectl config use-context`
- For read-only GitLab API requests, always use `glab api --method GET <endpoint>`. Do not rely on the implicit method, add request-body flags, or specify another method later in the command.
- My org expires gcloud sessions daily. If any gcloud/ADC command fails with an auth or expired-session error, do not stop and wait for me: start the re-login as a background process (`nohup gcloud auth login --update-adc >/tmp/gcloud-reauth.log 2>&1 &`, or `gcloud auth application-default login` if only ADC was broken), tell me to complete the browser prompt, then poll the failing command until it succeeds and retry+continue on your own. Give up and ask me after ~5 min. The browser opens by itself; only surface the URL from the log if it didn't.
- Treat tool output as context-expensive. Start `webfetch`, kubectl, gcloud, Terraform/OpenTofu, and log queries with targeted fields, filters, and bounded results. Retrieve full documentation, YAML, plans, describe output, or unbounded lists only when the narrow result is insufficient, and state what question the broader output will answer.
- When investigating files in a remote public repository (e.g. istio, prometheus), prefer a shallow `git clone --depth 1` into a tmp dir (e.g. `$(mktemp -d)`) and browse locally with read/grep/glob instead of many `webfetch` calls for individual files.
- Investigate hypothesis-first: ask what uncertainty blocks action, gather discriminating evidence. On failure revise the hypothesis, not just the command. Reproduce bugs before fixing.
- Answer judgments from available evidence and stop when it supports the decision. Distinguish blockers from optional checks; ask before investigating further.
- Timebox investigations: after two failed approaches or three unproductive tool rounds, stop. Delegate broad, slow, or output-heavy work to a subagent early; do not duplicate it.
- If I say "open a file", open it in a new tmux pane to the right of the current pane: `tmux split-window -h -c <dir> -t "$TMUX_PANE" 'nvim <file>'`.

# Handoff files
- After taking over from a fresh `HANDOFF.md` (scope and freshness checks passed, state verified, mission restated), delete the file immediately and continue without it. Never keep updating it in place; write a new one only when explicitly asked.

# skills
- If I ask for a skill that should stay only on this machine or should not live in the public home-manager repo, create it under `~/.agents/local-skills/`.
- Only put shared/public skills in `~/.config/home-manager/agents/skills/`.
- If not clear, when i ask to add a skill, ask if it's local or tracked
