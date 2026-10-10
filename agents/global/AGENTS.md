# This machine
- My terminal is Ghostty, usually running tmux.
- Almost everything is configured with home-manager in `~/.config/home-manager/` (a public repo; read its `AGENTS.md` before changing config). omp's own config lives in `~/.config/home-manager/agents/omp/`.
- Local secrets live in the gitignored `~/.config/home-manager/secrets.env`, sourced by zsh. Never print, copy or commit credentials.

# Tips
- Before running kubectl commands, check my contexts with `kubectl config get-contexts`; pass `--context` per command, never `kubectl config use-context`.
- For read-only GitLab API requests, always use `glab api --method GET <endpoint>`. Do not rely on the implicit method, add request-body flags, or specify another method later in the command.
- To open a file for me inside tmux, use a pane to the right: `tmux split-window -h -c <dir> -t "$TMUX_PANE" 'nvim <file>'`.
- For Google Cloud architecture, IAM, APIs, SDKs, or product behaviour, MUST use the Google Developer Knowledge MCP before generic web search.

# Skills
- Skills that must stay private to this machine go in `~/.agents/local-skills/`; team skills live in `~/.agents/team-skills/` (a team repo checkout). Never put either in a public repo.
