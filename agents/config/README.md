# Pinned workstation agent configuration

`lock.json` pins public `tomasmota/agents` at a real immutable commit, plugin API
2.0 / the exact OpenCode version in the consumer lock. Platform permissions, MCP/browser/provider endpoints,
primary model maps, CLI/quota adapters and local/team skill ownership stay here.
Generated snapshots are recovery artifacts, not installed/active proof.
`runtime/` separately locks OpenCode 2.0.22 and OpenChamber **web server** 2.0.0;
the native desktop cask is a separate client and needs its own version record.

## Everyday operations

A short quick-reference for ordinary small changes. The sections below and the
central `config/README.md` are the detailed runbooks; most changes need only the
one row that matches them.

### What owns what

| Thing | Edit it in | Reaches this machine by |
| --- | --- | --- |
| Shared roles, routing code, plugins, base instructions, portable skills | Central public `tomasmota/agents` (clean checkout, e.g. `/path/to/clean/agents`) | Committed and pushed, then adopted via a full SHA in `lock.json` |
| Workstation choices: primary model maps, permissions, MCP/browser/provider endpoints, CLI preferences, workstation-only instructions | `config/mac.json`, `config/platform.*`, `config/cli.json` here | `AGENTS_SOURCE=/path/to/clean/agents bash agents/config/manage.sh --render` (clean checkout at the locked SHA) |
| Generated outputs: `global/AGENTS.md`, `opencode/opencode*.json`, `opencode/subagents.jsonc`, shared helpers, generated skills, `config/inventory.*.json` | Never edit; change the source above and render | Out-of-store links (below) |
| Workstation-only public skills | Non-generated directory under `agents/skills/` (not inventory-owned) | Same links |
| Private/team skills | `~/.agents/local-skills/`; the team checkout linked by `~/.agents/team-skills/` | Never copied into a public repo |
| Runtime and services | `runtime/`, `../agents.nix`, `../darwin/{cliproxyapi,macos}.nix` | Nix build and switch |
| Owner's chosen primary model, session titles, UI settings | The apps themselves (mutable state, not policy) | Edits and switches should preserve them |

### Which client uses which server (Mac)

| Client | Server it uses |
| --- | --- |
| Terminal `opencode` (CLI/TUI) | The **default OpenCode background service** (`opencode service status`) |
| OpenChamber web (`org.nixos.openchamber`, always running on loopback `3001`) | Its **own managed OpenCode backend**, a separate process on its own port |
| Android | The web server above, through the Tailnet Serve proxy to loopback `3001` (configuration known; device connectivity not tested) |
| Native desktop (`openchamber-desktop`) | A client of the configured host only: no server of its own. It restarts only after a crash; Quit leaves it closed; web and Android do not depend on it |

The two OpenCode servers run the same locked runtime and read the same
`~/.config/opencode` files, but they are separate processes: each loads, and must
be reconciled, on its own. Bare `opencode api ...` reaches the default service,
**not** the app backend (see the explicit `--server` form below). Tmux status/quota
plugins and tmux pane opening are terminal-only; an inherited `TMUX` in a server's
environment does not prove the current client is a TUI.

This consumer is **Mac-only**: `agents.nix` is imported only by the macbook Home
Manager user, and the Linux `homeConfigurations.linux` target carries no OpenCode
adapter, generated config, runtime or activation (removed 2026-10-04).

### Small changes: what makes them active

`agents.nix` links `~/.config/opencode/{opencode.json,subagents.jsonc,cli.json,AGENTS.md}`,
the terminal plugins and `~/.agents/{skills,AGENTS.md}` **straight into this
checkout** (out-of-store symlinks). Once those links exist, a saved or rendered file
is already what both servers see on disk; no Nix switch is involved. A switch is for
changing the links, packages, runtime lock or launchd definitions. Restarts are
rarely needed.

| Change | Do |
| --- | --- |
| Local adapter or instruction edit (`platform.*`, `mac.json`, `cli.json`) | Render, then `node agents/config/check.mjs` (offline; `manage.sh --check` also compares against the clean central checkout). Routes hot-reload |
| Shared source change | Edit and push central first, then `manage.sh --update <full-SHA>` from a clean checkout of that SHA (see [Edit, update and validate](#edit-update-and-validate)) |
| Routing or model change | Render; `~/.cache/opencode/agent-routes.json` shows `errors` and the primary mapping if you want to look |
| Pin-only plugin reconciliation | Reload locations on **each** server. This is not `plugin update`, which skips full-SHA pins. No restart |
| Runtime, Nix or lifecycle change | `node agents/config/check.mjs`, `darwin-rebuild build --flake .#macbook`; the owner runs `sudo darwin-rebuild switch --flake .#macbook` |

Location reload rebuilds every loaded location on that server: pending permissions
and forms are cancelled and running sessions continue at the next step boundary.

```bash
opencode api post /api/location/reload                                             # default service
opencode api --server http://127.0.0.1:3001 post /api/location/reload             # managed app backend via its authenticated proxy
```

The managed backend's direct port requires its generated password. Use the
owned app's loopback API proxy instead: it forwards the same native `/api/*`
paths and supplies backend authentication without exposing credentials.
Successful reloads return HTTP 204 and no JSON body.

### Rendered, installed or active?

Rendered means the generated files match the sources. Installed means the files and
packages the servers resolve. Active means what a running server has loaded, for
the chosen server and location. `inventory.mjs` reports all three
(`intended`, `installed`, `active`) and exits non-zero if the checked parts
disagree; its `active.connection` names the server it asked.

```bash
node agents/config/check.mjs                              # rendered snapshots/adapters/pins consistent (offline)
opencode service status                                   # default service: running, version

# App backend port is ephemeral; read only selected /health fields (no auth material)
curl -fsS http://127.0.0.1:3001/health | node -e 'const h=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log({status:h.status,openCodePort:h.openCodePort,openchamberVersion:h.openchamberVersion})'

inv() { node agents/opencode/lib/inventory.mjs --inventory agents/config/inventory.mac.json --root "$PWD" --opencode "$(command -v opencode)" --installed-server "$HOME/.config/opencode/opencode.json" --installed-skills "$HOME/.agents/skills" --directory "$PWD" "$@"; }
inv                                                       # default service
inv --server http://127.0.0.1:3001                       # managed app backend via authenticated proxy
```

A direct backend connection takes credentials only from the CLI's own environment, never
from a URL or arguments; do not print them. A default-location pass does not prove
project overrides or per-request hook changes. Ports and PIDs change on restart, so
discover them each time rather than recording them.

## Instruction and skill ownership

The global `agents/global/AGENTS.md` is generated from local `platform.md` plus
central `config/instructions.md`. Investigation, proactive delegation/review,
tool/model hints, client detection and ownership heuristics live in the shared
base; keep only actual workstation differences here. Do not duplicate the base
in the adapter. See the central configuration README's ownership table before
adding instructions or skills; project conventions stay in project `AGENTS.md`.

Portable public skill sources live centrally and are selected by manifest profile,
not copied manually into this repo. `inventory.mac.json` records generated
skill ownership under `agents/skills/`; do not edit those files. Workstation-only
tracked skills use non-generated directories in that same tree. Private machine
skills stay in `~/.agents/local-skills/`; team skills stay in their own checkout
linked by `~/.agents/team-skills/`, never copied into either public repository.
When adding a tracked local skill, ensure its directory is not inventory-owned.

Use skill descriptions for ordinary discovery. Put necessary workstation-only
triggers in `platform.md`, and shared triggers centrally only when supported by all
affected profiles or guarded by availability. Neither a skill nor a shared rule
grants cloud contexts, browser access or credentials. Ask if publication scope is
unclear. Shared updates follow the pinned workflow below; local instructions
require render/check too. Mac target acceptance remains a separate native step.

Base-consolidation acceptance (2026-10-03): at central
`57c6edfc6ce2dece2ff5fd07ec1a8604960a6a92`, both profiles consumed the same base and
retained their previous server/routing/skill selections except for exact package
pins. Render/check and offline conformance passed; the full consumer suite passed
61/61 with the clean locked `AGENTS_SOURCE`. Linux flake check (`--no-build`) and
Mac system derivation evaluation passed. This is not native Mac build, switch or
installed/active proof; that acceptance remains blocked from Coder as documented
below.

Role-description follow-up (2026-10-03): the lock now pins central
`fd5deda2078c9eb32cc1fcc93c3207cbe2f96d23`. The `free` description refers only to
its adapter-selected model, not a global child-model policy. Render/check, offline
conformance and all 61 consumer tests passed; comparison with the previous
snapshots proves models, permissions, routing policy and skill selections are
unchanged apart from package pins and that description. Native Mac activation
remains unverified.

## Native Mac acceptance (2026-10-04)

The owner completed the native system switch at central
`f335fef5c53745da6ebcd2c16ddde4fcbf079019`. A reviewed follow-up at
`fc83fb007bcdfbfda9a5520ee17e028c985c6e97` preserves upstream denials in Jev;
both services reconciled that pin through location reload without restarting.
Shared tests passed 177/177; consumer tests passed 70/70 with `AGENTS_NIX_EVAL=1`
and no skips. Render and offline checks passed. Both the default CLI service and
OpenChamber backend run OpenCode 2.0.22; explicit home-manager-location inventories
prove all seven plugins active at the new pin, the selected runtime/configuration
and all five portable skill sources. OpenChamber web and native desktop are 2.0.0.
Coder was not deployed and remains on its previous pin and OpenCode 2.0.16.

Live disposable probes passed default quick/free/reviewer routing, general →
explore nesting, explicit reviewer model override and unchanged primary selection.
The actual app handoff created exactly one successor without a tmux tool call.
Desktop `SIGABRT` restarted it; normal Quit left it closed. After crash recovery
the desktop connected to the existing web server, with no Node descendant or TCP
listener. Web/backend remained healthy and unchanged throughout. Tailnet Serve
still targets the loopback web service. SIGKILL is not a launchd crash signal and
did not trigger the crash-only restart policy.

The live probe exposed a general child spawning quick: the later Jev hook
overwrote the routing hook's denial. The follow-up fixes this and adds composed
regression tests. Live permission evaluation on **both servers** now denies child
quick/question while allowing child explore and primary quick. An actual child
quick call was rejected with `permission.rejected`; both resumed and fresh
general → explore probes completed on the new pin. The resumed probe outlasted
client wait windows, but its stored result confirms success; no duplicate prompt
was sent. A fresh default quick probe passed too. Primary selection and service
PIDs stayed unchanged, and the route cache has no errors.

Real quota exhaustion was not forced; fallback behavior remains source-test/cache
evidence. Android connectivity and confirmed-TUI owning-pane handoff remain
owner-side checks, not native results from this web session.

## Edit, update and validate

Edit portable behavior in central source; test/commit/push there first. Edit
workstation choices in `platform.macos.json`, `platform.md`, `mac.json` and
`cli.json` here. Never edit generated server/instruction/helper/portable-skill
files directly. Private local/team contents never enter either public repo.
HEY's upstream redistribution license is unspecified; metadata does not claim
an established license. CLI installer markers are local metadata, not policy.

From this repo, with a clean central checkout matching the desired full SHA:

```bash
AGENTS_SOURCE=/path/to/clean/agents bash agents/config/manage.sh --update <full-SHA>
bash agents/config/manage.sh --check
node agents/config/check.mjs
AGENTS_SOURCE=/path/to/clean/agents node --test --test-timeout=60000 agents/omp/test/*.test.mjs agents/opencode/tests/*.test.mjs agents/config/test/*.test.mjs agents/runtime/test/*.test.mjs
nix flake check --no-build
nix run --inputs-from . nixpkgs#alejandra -- --check .
nix run --inputs-from . nixpkgs#statix -- check .
```

Rendering is offline. Every mode renders the Mac profile in memory and
validates before publishing; update advances
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
the networked npm install happens during activation. nix-darwin starts user launchd
agents before Home Manager, so nix-darwin `extraActivation` runs
`agents.activationPreflight` as the user after `checks` and before launchd. A
failure aborts the switch with old services loaded; the profile link may already
point to the new generation. `agents/runtime/test/activation.test.mjs` audits
the pinned order; `AGENTS_NIX_EVAL=1` adds evaluated-script proof. Isolated proof:

```bash
nix shell --impure --expr '(builtins.getFlake (toString ./.)).darwinConfigurations.macbook.pkgs.nodejs_24' -c bash agents/runtime/smoke.sh
```

CI runs the same smoke on its Linux runner only as a portable install-logic test;
no Linux target installs the runtime.

## Mac deployment and native acceptance

These commands and client checks must run on the Mac.
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
node agents/opencode/lib/inventory.mjs --inventory agents/config/inventory.mac.json --root "$PWD" --opencode "$(command -v opencode)" --installed-server "$HOME/.config/opencode/opencode.json" --installed-skills "$HOME/.agents/skills" --directory "$PWD"
darwin/cliproxyapi/verify.sh
launchctl kickstart -k "gui/${UID}/org.nixos.openchamber-desktop"
```

Prove the CLI reaches the **same server as OpenChamber**, not a stale separately
managed background service. Get `openCodePort` from the loopback web server's
`/health` response and repeat the inventory with
`--server http://127.0.0.1:<openCodePort>`. Check its reported connection, server
PID, runtime and active pins; do not print service authentication material. Default-location
inventory does not prove project overrides or hook-modified requests. Record
exact installed versions, central pin, active packages and skill source results
for the intended locations, without raw configuration/environment/auth dumps.

Use disposable fictional sessions to verify: primary choices unchanged; default and explicit child calls (explore, reviewer, quick, free, nested) select the
models configured in `subagents.jsonc`, and the quota fallbacks behave as configured; app handoff produces one
successor without a tmux pane; confirmed TUI handoff targets only its owning
pane. CLI quotas/status/notifications remain terminal-only, not Android parity.
Verify explicit desktop Quit stays closed, crash restarts, reconnect uses only
configured host (no local server), and web/Android work while desktop is closed.
Crash-only desktop KeepAlive is separate from the always-running server.

Rollback never implies database downgrade is supported: inspect upstream
migration compatibility before selecting an older runtime. If unsupported,
retain the compatible runtime and revert only compatible config, or rebuild
disposable state. Do not claim a preserved predecessor exists without checking.
