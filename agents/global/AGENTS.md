# This machine
- Almost everything is configured with home-manager in `~/.config/home-manager/` (a public repo; read its `AGENTS.md` before changing config). omp's own config lives in `~/.config/home-manager/agents/omp/`.
- Local secrets live in the gitignored `~/.config/home-manager/secrets.env`, sourced by zsh. Never print, copy or commit credentials.
- The bash tool and eval's JS kernel inherit the full environment; eval's Python kernel only gets allowlisted variables plus the `PI_*`, `XDG_*` and `LC_*` prefixes. `secrets.env` mirrors secrets that Python cells need as `PI_<NAME>` (for example `PI_NETBIRD_API_TOKEN`); use the mirror rather than assuming the plain name exists.

# Skills
- Skills that must stay private to this machine go in `~/.agents/local-skills/`; team skills live in `~/.agents/team-skills/` (a team repo checkout). Never put either in a public repo.
