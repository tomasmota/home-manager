# This machine
- My terminal is ghostty
- Almost everything is configured using home-manager. All config is located at `~/.config/home-manager/`. If I ask you to change some configuration in home-manager, this is where you will find it. Read `~/.config/home-manager/AGENTS.md` for more information.

# Tips for you
- if you want to run kubectl commands, first check my contexts with `kubectl config get-contexts`
- if you want to run commands in a context, use `kubectl --context`, not `kubectl config use-context`
- For read-only GitLab API requests, always use `glab api --method GET <endpoint>`. Do not rely on the implicit method, add request-body flags, or specify another method later in the command.
- Gcloud re-auth is handled by the `tomas.gcloud-auth-healer` plugin: when a gcloud/ADC command fails with an expired-session error it starts the re-login in the background and posts a synthetic message. Follow that message (complete the browser prompt, poll the failing command, give up after ~5 min).
- In a confirmed tmux TUI, opening a file uses a pane to the right: `tmux split-window -h -c <dir> -t "$TMUX_PANE" 'nvim <file>'`. The shared base owns client detection; this command is not an OpenChamber action.

# skills
- If I ask for a skill that should stay only on this machine or should not live in the public home-manager repo, create it under `~/.agents/local-skills/`.
- Workstation-specific tracked skill sources live under `agents/skills/`, alongside generated portable skills. Consult `agents/config/README.md` and its inventories to distinguish ownership before editing.
