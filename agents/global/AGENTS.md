# This machine
- Almost everything is configured with home-manager in `~/.config/home-manager/` (a public repo; read its `AGENTS.md` before changing config). omp's own config lives in `~/.config/home-manager/agents/omp/`.
- Local secrets live in the gitignored `~/.config/home-manager/secrets.env`, sourced by zsh. Never print, copy or commit credentials.

# Skills
- Skills that must stay private to this machine go in `~/.agents/local-skills/`; team skills live in `~/.agents/team-skills/` (a team repo checkout). Never put either in a public repo.
