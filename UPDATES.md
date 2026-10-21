# Updates

Runbook for an agent asked to update this repository. This is an update procedure, not a changelog; keep actual versions, revisions and hashes in their owning configuration files.

## Scope and defaults

- Update all dependency surfaces below, rediscovering any added since this list was written. Read upstream release and migration notes, and make compatibility changes needed by the updates; do not redesign the environment or add tools.
- Prepare and validate changes by default. Do not switch the system, replace native apps, restart services, commit or push unless requested. Finish independent updates even when another item needs owner action.
- Preserve existing user changes and runtime-owned settings. Follow the ownership rules in the component guides, especially for omp configuration, credentials and private skills.
- This is a public repository: no secrets, private work inputs or work-specific configuration. Do not expand this into upgrading every application or executable on the workstation.

## Update surfaces

| Surface | Procedure |
| --- | --- |
| Nix packages and flake inputs | Run `nix flake update` to regenerate `flake.lock`; this includes nixpkgs, Home Manager, nix-darwin and omp. Do not use a second installer or self-updater for Nix-owned tools. See [omp ownership and activation](agents/omp/README.md). |
| Intentional compatibility pins | Review the constraints and linked upstream blockers in [flake.nix](flake.nix), including the separate Azure CLI input. Updating the lock does not advance revisions embedded in input URLs. Remove a workaround only after its blocker is resolved and the replacement is verified; otherwise retain it and report why. Apply the same rule to explicit plugin version and branch constraints. |
| Tern SDK and plugins | Update the SDK, Tern Kube and Agent Scheduler `rev`/`hash` pairs in [darwin/tern.nix](darwin/tern.nix) from their upstream sources. Check compatibility with the installed native app and review the local Kube patch against upstream; do not drop it just to make an update build. Follow the [Tern guide](darwin/tern/README.md); never replace these managed plugins through Tern's installer. |
| MCP package and schema references | Review the pinned Chrome DevTools MCP npm version and omp schema revision in [agents/omp/mcp.json](agents/omp/mcp.json). Keep arguments and schema compatible with their updated runtimes, preserving the intentional tool-category/privacy settings. Hosted MCP services are not locally installed packages. |
| Neovim plugins | Use [lazy.nvim's update flow](https://lazy.folke.io/usage), for example `nvim --headless '+Lazy! update' +qa`, to regenerate [nvim/lazy-lock.json](nvim/lazy-lock.json); never hand-edit plugin commits. Confirm Neovim is using this checkout's configuration first. This updates live plugin installations as well as the lockfile. Check build hooks, including the Treesitter `:TSUpdate` hook. |
| Neovim language tools | Mason-managed tools are separate from both Nix packages and the Lazy lock. Refresh Mason's registry, wait for it to finish, then use [`:MasonToolsUpdateSync`](https://github.com/WhoIsSethDaniel/mason-tool-installer.nvim#commands) for the tools declared in [lsp.lua](nvim/lua/plugins/lsp.lua). Startup installation is intentionally disabled; do not enable it as an update workaround. |
| CI actions | Review action references in [.github/workflows/validate.yml](.github/workflows/validate.yml) against supported upstream releases and their runner/runtime requirements. These are not updated by the flake lock. |
| Homebrew casks | [darwin/macos.nix](darwin/macos.nix) declares unversioned casks and enables Homebrew update/upgrade on Darwin activation. There is no per-cask revision to bump here. Without activation, report these as pending rather than claiming the apps were upgraded. |
| Locally owned code, configuration and skills | These are maintained here, not refreshed by copying upstream templates. Make necessary compatibility fixes and run the relevant existing checks. Codex Usage is built from [local sources](darwin/codex-usage/install.sh) during activation when its source/Swift stamp changes; it has no external app release to bump. |

## Validation

1. Review the dependency changes and any retained constraints. Obtain fixed-output hashes from the actual upstream sources; do not weaken integrity checks to get a build through.
2. After the related edits, run `nix flake check --all-systems -L`. This evaluates both configured hosts and builds checks for the current system. Use the [host build commands](README.md#validate--build-without-switching) to build without switching.
3. Exercise affected behavior, not just evaluation: launch the updated CLI/editor or test its changed integration using the newly built package where possible. Interactive terminal checks belong in task-owned Tern blocks. Follow component-specific checks rather than inventing a second test convention.
4. New source files must be visible to the Git flake snapshot before building. Never use `--flake path:.` as a workaround: it can copy gitignored secrets into the Nix store.
5. Distinguish successful checks from unavailable or unexercised behavior. If the new native app or activation is needed for a smoke check, identify that prerequisite and leave that check explicitly pending.

## Owner-installed apps and activation

### Tern

Tern itself is owner-installed at `/Applications/Tern.app`; Nix manages only its integration. Check the installed version and official [Stencil release/download information](https://stencil.so/tern), then tell the owner when a download or native-app update is needed. Give the installed/target version when discoverable, the official link and the required action. If release information requires owner access, say so instead of guessing the latest version.

Follow [Tern's upgrade procedure](darwin/tern/README.md#upgrades). Warn before any daemon restart: it may interrupt active work or replace shell state. Do not introduce an app pin, alternate installer, isolated rehearsal, pane/process inventory, native UI automation or screenshots for a routine update. Basic version/service checks are enough; the owner verifies rendering, plans/applies and phone behavior. If a plugin update requires a newer app, do not advance it into an incompatible installed setup; report the prerequisite.

### Applying prepared changes

Unless explicitly asked to apply, leave the build ready and give the owner the appropriate command:

- macOS: `sudo darwin-rebuild switch --flake .#macbook` (or the documented `nds`/`ndsh` helpers).
- Linux: `home-manager switch --flake .#linux`.

Explain any required fresh processes, plugin reloads or deferred checks using the component guides. A build is not activation; do not report installed versions from the new lockfile alone. Other owner-installed prerequisites should be handled the same way: identify their existing installation source and required action, rather than silently changing package ownership.

## Completion report

- Updated components and meaningful version changes; important upstream behavior changes or required migrations.
- Surfaces already current, intentionally retained pins with reasons, and failures or inaccessible sources.
- Exact checks and smoke paths exercised, with results and anything still unverified.
- A separate **Owner actions** list: downloads/official links, activation commands, restarts or fresh sessions, and checks that need the owner's installed app. Say explicitly when there are none.

Do not write per-run results back into this file. Update this runbook only when ownership or the update procedure changes.
