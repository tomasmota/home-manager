# AGENTS.md

## Purpose
- This repo manages Tomás' local developer environment with Nix, using Home Manager on Linux and nix-darwin + Home Manager on macOS.
- Treat this repo as the source of truth for shell, Tern terminal, editor, git, and AI-agent config.

## Public Repository
- This repository is public. Never add sensitive personal or company information, including credentials, tokens, private URLs, customer data, internal infrastructure details, or confidential business information.

## Host Targets
- macOS target: `darwinConfigurations.macbook` (`aarch64-darwin`, home `/Users/tomas`).
- Linux target: `homeConfigurations.linux` (`x86_64-linux`, home `/home/tomas`).
- Username is hardcoded as `tomas` in `flake.nix`.

## Repo Map
- `flake.nix`, `flake.lock`: flake entrypoint and pinned inputs (`nixpkgs`, `home-manager`, `nix-darwin`, `omp`).
- `home.nix`: shared Home Manager module; imports most local modules and declares common packages.
- `darwin/macos.nix`: macOS-only nix-darwin config (system defaults, Homebrew casks, Tailscale).
- `darwin/tern.nix`, `darwin/tern/`: Native Stencil Tern integration (user-installed `/Applications/Tern.app`, managed session daemon and settings). Nix never installs or pins the app. See `darwin/tern/README.md` for activation, upgrades and withdrawal.
- `agents/omp/`: Oh My Pi (omp), Mac-only via the pinned `omp` flake input. `agents/omp/default.nix` manages its runtime configuration, MCP servers, extensions and native agent definitions. `agents/omp/brief/` is the `brief` CLI and extension for fixed per-session context. Shared user instructions and skills live alongside it under `agents/`; see `agents/omp/README.md`.
- `darwin/codex-usage/`: Codex Usage menu bar app (Swift). Built into `~/Applications/CodexUsage.app` by `install.sh` via a home-manager activation script when sources change; kept running by the `codex-usage` launchd agent.
- `shell/zsh.nix`, `shell/aliases.nix`, `shell/functions.nix`: shell behavior, aliases, helper functions.
- `git.nix`: git identity/signing, difftastic, activation hook for `allowed_signers` files.
- `nvim/`: Neovim config (lazy.nvim, plugin specs under `nvim/lua/plugins`, core config under `nvim/lua/config`).
- `agents.nix`, `agents/**`: locally owned shared instructions, public skills and native omp configuration, installed into `~/.agents/` and `~/.omp/agent/` on the Mac. Edit these files directly.
- OpenChamber is used through the homelab web UI. Do not install local OpenCode, OpenChamber servers, the desktop bundle or subscription gateways.
- `secrets.env`: local secrets file at repo root, intentionally gitignored.

## Configuration Composition Notes
- `home.nix` uses an out-of-store symlink for `nvim`; `agents.nix` links shared instructions and skills from this checkout into `~/.agents/`.
- Once those links exist, saved files are live on disk. Reload omp discovery or start a fresh session for instruction/skill changes; a switch is needed for links, packages or services.
- `agents/omp/` owns local agent runtime behavior; `agents/global/` and `agents/skills/` own shared user instructions and skills.

## Apply and Validate Workflows
- Match validation to risk. Small declarative edits (removing a setting, changing a flag, comments) do not warrant `darwin-rebuild` or `nix flake check`; use a targeted check when it answers a concrete correctness question.
- Run builds for changes whose correctness depends on Nix evaluation or building: module wiring, package/derivation changes, activation scripts, or explicit user requests. Reserve `nix flake check -L` for cross-cutting changes (CI adds `--all-systems`).
- Editing config does not imply applying it. Run `switch` only when the user requests activation, using an interactive terminal so they can authenticate with Touch ID or a password; `sudo -n` failure alone is not a blocker. Out-of-store symlinked files generally need no rebuild.
- Linux:
  - Build only: `home-manager build --flake .#linux`
  - Apply: `home-manager switch --flake .#linux`
- macOS:
  - Build only: `darwin-rebuild build --flake .#macbook`
  - Apply: `sudo darwin-rebuild switch --flake .#macbook`
- Update dependencies:
  - `nix flake update` (then commit `flake.lock` changes)

## Tern upgrades
- The owner installs and updates `/Applications/Tern.app` normally; Nix manages only integration. Follow `darwin/tern/README.md` for native-app upgrades and service restarts.
- Warn that a daemon restart may interrupt active work or replace shell state. Do not promise process or session continuity.
- Keep routine upgrades simple. Do not create isolated upgrade rehearsals, inventory every pane/process, automate the native UI or capture screenshots unless explicitly requested.
- Basic version/service checks are sufficient for a routine upgrade. The owner verifies plans, applies, rendering and phone behavior.

## Editing Conventions
- Nix:
  - Keep existing style (2-space indentation, semicolon-terminated attrs, small focused modules).
  - Prefer editing the specific module rather than growing `home.nix`.
  - Do not hand-edit `flake.lock`; update it via `nix flake update`.
- Lua/Neovim:
  - Keep plugin config in `nvim/lua/plugins/*.lua` and base options/keymaps/autocmds in `nvim/lua/config/*`.
  - `nvim/lazy-lock.json` is generated by lazy.nvim; only change intentionally when updating plugins.
- Shell:
  - Keep aliases/functions concise and compatible with zsh.
  - `secrets.env` may be sourced by zsh init; never commit credentials.
- Agent instructions and skills:
  - Edit locally owned shared instructions and public skills directly in `agents/`.
  - Private machine skills stay in `~/.agents/local-skills/`; team skills stay in `~/.agents/team-skills/`. Never copy their contents into this public repo.
  - Keep the existing skill frontmatter style (`name`, `description`, and `metadata`) and usage-oriented sections.
- Documentation:
  - Across the repo, keep `README.md` and `AGENTS.md` additions to one or two sentences or a few short bullets; link existing guidance instead of repeating it.
  - READMEs consume agent context: include only factual, relevant, permanent information needed for future work that is not obvious from the corresponding code.
  - Omit history, checkpoints, incident narratives, verification logs and other transient details; keep pins and hashes in configuration.

## Safety and Gotchas
- `git.nix` writes `allowed_signers` files during activation; keep this behavior in mind when changing git/signing config.

## Commit Hygiene
- Keep commit messages short, imperative, and lowercase (matches current history style).
- Never commit `secrets.env` or other credential-bearing local files.
