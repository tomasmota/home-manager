# AGENTS.md

## Purpose
- This repo manages Tomás' local developer environment with Nix, using Home Manager on Linux and nix-darwin + Home Manager on macOS.
- Treat this repo as the source of truth for shell, terminal, editor, git, tmux, and AI-agent config.

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
- `darwin/cliproxyapi.nix`: CLIProxyAPI (OpenCode's Claude subscription gateway, loopback 8317) and the OpenChamber launchd service; local secret-bearing state lives under `~/.config/cliproxyapi` (see `darwin/cliproxyapi/README.md`).
- `darwin/omp.nix`: omp auth broker (8765) + auth gateway (4000) launchd user agents; additive, never touches CLIProxyAPI.
- `omp.nix`, `agents/omp/`: Oh My Pi (omp) agent config, Mac-only via the pinned `omp` flake input; declarative settings in `programs.omp.settings`, writable-copy `mcp.json`, and repo-tracked `RULES.md`/`agents/` symlinked into `~/.omp/agent/`. See `agents/omp/README.md` for the OpenCode→omp preference mapping, auth runbook and known gaps.
- `darwin/codex-usage/`: Codex Usage menu bar app (Swift). Built into `~/Applications/CodexUsage.app` by `install.sh` via a home-manager activation script when sources change; kept running by the `codex-usage` launchd agent.
- `terminal/ghostty.nix`: Ghostty config; expects `fontSize` from flake `extraSpecialArgs`.
- `shell/zsh.nix`, `shell/aliases.nix`, `shell/functions.nix`: shell behavior, aliases, helper functions.
- `git.nix`: git identity/signing, difftastic, activation hook for `allowed_signers` files.
- `tmux.nix`: tmux settings/plugins/keybindings.
- `nvim/`: Neovim config (lazy.nvim, plugin specs under `nvim/lua/plugins`, core config under `nvim/lua/config`).
- `agents.nix`, `agents/**`: AI tool configs (OpenCode/OpenChamber), **Mac-only**: `agents.nix` is imported only by the macbook Home Manager user in `flake.nix`; the Linux target carries no OpenCode config, runtime or activation. `agents/global/AGENTS.md` is installed as the global agent instructions; `agents/AGENTS.md` applies only while working in the tracked `agents/` tree.
- Shared roles, routing code, portable skills and instructions are canonical in public `tomasmota/agents`. `agents/config/lock.json` pins that source; `agents/config/mac.json` and `platform.*` are the workstation adapters. See `agents/config/README.md` for the update/deploy/rollback workflow.
- `agents/skills/**`: generated portable skills plus local workstation-only skills. Do not edit generated files; local/team skill ownership remains separate.
- `secrets.env`: local secrets file at repo root, intentionally gitignored.

## Configuration Composition Notes
- `home.nix` imports:
  - `./terminal/ghostty.nix`
  - `./shell/zsh.nix`
  - `./git.nix`
  - `./tmux.nix`
- The macbook Home Manager user additionally imports `./agents.nix` and `./omp.nix` (`flake.nix`).
- `home.nix` uses out-of-store symlinks for `nvim` and `agents` directories.
  - Once a switch has created the links, editing files in this repo updates live config targets directly; a further switch is needed only to change the links, packages or services (see `agents/config/README.md`).
- `agents.nix` symlinks repo files into:
  - `~/.config/opencode/opencode.json` (from `agents/opencode/opencode.macos.json`)
- Every shared server package, including agent-routes, uses the immutable central SHA. Full-SHA packages are skipped by `plugin update`; a location reload reconciles new pins. Pulling the repository alone is not installed/active proof.
- `agents/opencode/lib/` includes generated shared helpers and the locally owned session registry. The local `plugins/agent-routes/quota.js` is only a credential/quota adapter, not a discovered server plugin.
- `agents/runtime/` locks OpenCode/OpenChamber and installs the content-addressed runtime; Nix/launchd select it rather than Homebrew or npm-global binaries.

## Apply and Validate Workflows
- Preferred validation before applying:
  - `nix flake show`
  - `nix flake check`
- Linux:
  - Build only: `home-manager build --flake .#linux`
  - Apply: `home-manager switch --flake .#linux`
- macOS:
  - Build only: `darwin-rebuild build --flake .#macbook`
  - Apply: `sudo darwin-rebuild switch --flake .#macbook`
- Update dependencies:
  - `nix flake update` (then commit `flake.lock` changes)

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
- Agent policies:
  - Edit the central source for shared behavior, platform adapters here for workstation choices; render and check before switching. Generated `opencode*.json`, routes and global instructions are not policy sources.
- Agent skills:
  - Add portable public skills centrally. Only workstation-specific tracked skills belong under `agents/skills/<skill-name>/SKILL.md`; private local/team contents never enter either public repository.
  - Keep the existing frontmatter style (`name`, `description`, and `metadata`) and include usage-oriented sections.

## Safety and Gotchas
- `git.nix` writes `allowed_signers` files during activation; keep this behavior in mind when changing git/signing config.

## Commit Hygiene
- Keep commit messages short, imperative, and lowercase (matches current history style).
- Never commit `secrets.env` or other credential-bearing local files.
