# Pinned workstation agent configuration

`lock.json` pins public `tomasmota/agents` at a real immutable commit, plugin API
2.0 / OpenCode 2.0.16. Platform permissions, MCP/browser/provider endpoints,
primary model maps, CLI/quota adapters and local/team skill ownership stay here.
Generated snapshots are recovery artifacts, not installed/active proof.
`runtime/` separately locks OpenCode 2.0.16 and OpenChamber **web server** 2.0.0;
the native desktop cask is a separate client and needs its own version record.

## Edit, update and validate

Edit portable behavior in central source; test/commit/push there first. Edit
workstation choices in `platform.*.json`, `platform.md`, `{mac,linux}.json` and
`cli.json` here. Never edit generated server/instruction/helper/portable-skill
files directly. Private local/team contents never enter either public repo.
HEY's upstream redistribution license is unspecified; metadata does not claim
an established license. CLI installer markers are local metadata, not policy.

From this repo, with a clean central checkout matching the desired full SHA:

```bash
AGENTS_SOURCE=/path/to/clean/agents bash agents/config/manage.sh --update <full-SHA>
bash agents/config/manage.sh --check
node agents/config/check.mjs
AGENTS_SOURCE=/path/to/clean/agents node --test --test-timeout=60000 agents/opencode/tests/*.test.mjs agents/config/test/*.test.mjs agents/runtime/test/*.test.mjs
nix flake check --no-build
nix run --inputs-from . nixpkgs#alejandra -- --check .
nix run --inputs-from . nixpkgs#statix -- check .
```

Rendering is offline. Every mode renders both profiles in memory, rejects
conflicting shared outputs (routes/instructions/CLI/helpers/skills must be
byte-identical across profiles) and validates before publishing; update advances
the lock only after publication. Publication of multiple files is still not
atomic: on interrupted/failed I/O, do not switch; rerun `--render` then both
checks. The read-only offline checker rejects symlinks at or below the checkout
root but permits symlinked ancestors (for example macOS `/tmp`); the renderer is
stricter and rejects them. To restore a previous configuration,
restore its committed lock/adapters and render from that **clean pinned** central
revision. Never use `main` as a runtime pin or blindly overwrite unrelated work.
New full-SHA packages are reconciled on location reload; `plugin update` skips
immutable pins. Installed cache presence is not active package proof.

Runtime activation uses repository-selected Nix Node/npm, strict lifecycle
allowlisting, stage validation before publication and an install lock. A damaged
immutable runtime fails without overwrite; inspect it and use a deliberately
reviewed new destination/rebuild, never delete broad npm/global state. A stale
install-lock after process death requires confirming no installer is active
before removing **that exact empty lock directory**. Build is not installation:
the networked npm install happens during Home Manager activation. Isolated proof:

```bash
nix shell --impure --expr '(builtins.getFlake (toString ./.)).homeConfigurations.linux.pkgs.nodejs_24' -c bash agents/runtime/smoke.sh
```

## Mac deployment and native acceptance (blocked from Coder)

No approved Mac remote path exists from the guest. These commands and client
checks must run on the Mac; Linux evaluation/scratch installation is not proof.
Preserve owner mutable model/UI choices and local/team skill directories.

```bash
cd ~/.config/home-manager
node agents/config/check.mjs
darwin-rebuild build --flake .#macbook
sudo darwin-rebuild switch --flake .#macbook
zsh -lic 'command -v opencode; opencode --version'
launchctl kickstart -k "gui/${UID}/org.nixos.openchamber"
opencode service restart
opencode service status
opencode api get /api/info
opencode api post /api/location/reload
node agents/opencode/lib/inventory.mjs --inventory agents/config/inventory.mac.json --root "$PWD" --opencode "$(command -v opencode)" --installed-server "$HOME/.config/opencode/opencode.json" --installed-skills "$HOME/.agents/skills"
darwin/cliproxyapi/verify.sh
launchctl kickstart -k "gui/${UID}/org.nixos.openchamber-desktop"
```

Prove the CLI reaches the **same server as OpenChamber**, not a stale separately
managed background service. Explicit `opencode api --server <local URL>` can
select it; do not print service authentication material. Default-location
inventory does not prove project overrides or hook-modified requests. Record
exact installed versions, central pin, active packages and skill source results
for the intended locations, without raw configuration/environment/auth dumps.

Use disposable fictional sessions to verify: primary choices unchanged; default,
explicit paid override and nested child calls actually select Space Bunny, with
no paid fallback; unavailable child fails clearly; app handoff produces one
successor without a tmux pane; confirmed TUI handoff targets only its owning
pane. CLI quotas/status/notifications remain terminal-only, not Android parity.
Verify explicit desktop Quit stays closed, crash restarts, reconnect uses only
configured host (no local server), and web/Android work while desktop is closed.
Crash-only desktop KeepAlive is separate from the always-running server.

Rollback never implies database downgrade is supported: inspect upstream
migration compatibility before selecting an older runtime. If unsupported,
retain the compatible runtime and revert only compatible config, or rebuild
disposable state. Do not claim a preserved predecessor exists without checking.
