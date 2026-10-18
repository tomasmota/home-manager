# Stencil Tern

This is [Stencil's Rust-native Tern](https://stencil.so/tern), not tern.build.
Tern is the omp interface on Mac and Android. Activation does not need a full
Darwin switch; command and service names retain the `tern-pilot` prefix.

See [PILOT.md](PILOT.md) for the workflow and physical-phone checks.

## Prerequisites

Install Tern normally at `/Applications/Tern.app` (Apple Silicon release from
Stencil). Nix never installs, pins or modifies it. The browser client's HTML,
JavaScript and icons come from the app; its matching WASM is distributed
separately. Cache the complete client privately at
`~/.local/share/tern-web/<installed version>/`, with `index.html` at the root
and the WASM at `pkg/stencil_tern_web_bg.wasm`. The web and gateway services
read `CFBundleShortVersionString` from the app's `Info.plist` at each start and
use only that directory; a missing directory stops them rather than falling back
to older assets. Serve the WASM locally while retaining the release's SHA-384
integrity check. Never cache app archives, browser archives or account data in
this public repository.

The phone entrypoint uses the plain HTTPS origin, without `?token=`.
An owner-only Tailscale Serve gateway authenticates the requester and injects
the private token into the loopback backend's WebSocket handshake. The browser
never receives that token.

The web client supports **only its serving machine**. Its Add remote host
dialog explicitly rejects other hosts; multi-host connections belong to the
native Tern app. The Mac browser endpoint and a separate Linux endpoint remain
independent. Native Stencil-account sign-in and omp-provider authentication are
separate from the web server's private bearer token.

## Runtime and activation

[`runtime/default.nix`](runtime/default.nix) only points at the stable binary
`/Applications/Tern.app/Contents/MacOS/tern` and provides an unversioned `tern`
wrapper for it. The daemon, web server and `tern` CLI all use that binary, so
updating the app normally updates them on the next service start.

Activation links `~/.local/bin/tern` to the binary when absent. It replaces an
existing link only when the retired `~/.local/state/tern-pilot/cli-target`
record names it, then deletes that record; any other file or link is left
untouched.

Activation also installs `~/.local/state/tern-pilot/cli-env.zsh` and one
guarded source line in the gitignored `shell/local.zsh`, so the wrapper precedes
any stale `tern` in the system profile. Existing shells need a new shell or to
source that file.

Do not enable Tern-managed omp installation or background updates; omp stays
Nix-managed.

From the repository, build only the pilot:

```sh
nix build --no-link --print-out-paths .#darwinConfigurations.macbook.config.system.build.ternPilot
```

Use the printed store path, as the owning user **without sudo**:

```sh
<returned-store-path>/bin/tern-pilot-activate
<returned-store-path>/bin/tern --version
open /Applications/Tern.app
```

Full activation bootstraps five pilot LaunchAgents. It does not install or
modify the app or switch Darwin. Repeating it accepts identical
configuration; differing loaded configuration is refused so ongoing Tern turns
can finish before the daemon owner changes.

A `sudo darwin-rebuild switch --flake .#macbook` also applies this module, but
it is not the pilot activation path.

### Upgrades

Update `/Applications/Tern.app` normally; replacing it does not update
already-running app or daemon processes.

1. Finish active Tern work first; restarting the daemon may interrupt programs
   and replace shell state.
2. Cache the matching browser client at
   `~/.local/share/tern-web/<new version>/`. Never substitute a guessed URL, a
   login page or an unreviewed version.
3. Quit the old native app and reopen `/Applications/Tern.app`. If the daemon
   still runs the old build, use Tern's **Restart session daemon** command.
4. Restart the web and gateway jobs so they derive the new assets directory
   (`launchctl kickstart -k "gui/$(id -u)/org.nixos.tern-pilot-web"`, likewise
   `-gateway`), then check `tern --version` and the service status (see
   Inspect and withdraw).

### Browser-only updates

For a browser-only update that deliberately leaves the native app and daemon running:

```sh
<returned-store-path>/bin/tern-pilot-activate --web-only
```

This requires the managed daemon before preflight, does not disable/unload
either daemon service, and replaces only changed web/gateway/tailnet jobs.
It updates the CLI link and keyboard settings without stopping pane programs.
It deliberately does not upgrade the running native app or daemon.

Missing web assets for the installed version still leave browser access
blocked. A fresh installation uses full activation, not `--web-only`.

## Keyboard settings

Home Manager activation and `tern-pilot-activate` run `tern-settings-apply`,
which merges the managed tmux-preset settings (Ctrl+Space prefix, bindings in
[`tern.nix`](../tern.nix)) into Tern's writable `settings.json`. Unrelated UI
preferences survive; managed preset, prefix and bindings are reapplied. To
apply only these settings from a built pilot, run
`<returned-store-path>/bin/tern-settings-apply`, then use Tern's **Reload
settings** command; no service restart or Darwin switch is needed.

Native bindings beyond tabs and panes: `Ctrl+Space i` opens the inbox and
`Ctrl+Space g` opens a new Git block.

Session cycling (`Ctrl+Space Tab` / `Shift+Tab`) is native-only: the
[`session-navigation`](session-navigation) window plugin does not run in the
browser client. `tern-settings-apply` links it into Tern's plugin directory,
and Tern reloads plugins without a daemon restart.

## SDK example plugins

Home Manager installs the SDK's
[Terraform plan](https://docs.stencil.so/tern/examples/terraform.html) and
[JSON Explorer](https://docs.stencil.so/tern/examples/jsonx.html) examples as
directory symlinks under `~/Library/Application Support/Tern/plugins/`;
`darwin/tern.nix` owns the SDK revision and source hash. The links come from
the next Home Manager activation (Darwin switch), not `tern-pilot-activate`.
Keep the managed package read-only and update its Nix revision and hash rather
than replacing it through Tern. See the upstream docs for usage.

## Kubernetes plugin

Home Manager pins [Tern Kube](https://github.com/contrafy/tern-kube) in `darwin/tern.nix`; settings live at `~/.config/tern-kube/config.json`, and the optional shell guard stays off.
Use trusted kubeconfigs and manifests; mutation previews and secret masking are advisory, not security guarantees.

## Services and private state

LaunchAgents live in `~/Library/LaunchAgents/` as `<label>.plist` and run in the
owning user's GUI launchd domain:

| Label | Role |
| --- | --- |
| `org.nixos.tern-pilot-daemon` | `tern daemon`; AbandonProcessGroup keeps launchd from killing the remaining process group on exit but does not guarantee uninterrupted panes. |
| `org.nixos.tern-pilot-web` | Genuine assets and token-protected loopback backend on 8377. |
| `org.nixos.tern-pilot-gateway` | Loopback 18377: owner-only Tailscale identity, exact WebSocket Origin, private backend token injection. |
| `org.nixos.tern-pilot-tailnet` | Adds the HTTPS route after an authenticated gateway root GET. |
| `org.nixos.tern-pilot-awake` | `/usr/bin/caffeinate -i`; prevents idle system sleep for remote access. |

Exact settings (throttles, umask 077, environment) are in
[`tern.nix`](../tern.nix). The daemon silently sources the repository's
gitignored `secrets.env` for the existing omp environment; a failed load stops
startup. Do not inspect or copy that file into reports.

The app also registers `so.stencil.tern.daemon`. Full pilot activation disables
and unloads that bundled service and configures the Nix daemon job. An
already-running app-spawned daemon can still hold the default socket
(`~/Library/Application Support/Tern/daemon.sock`). The daemon wrapper then
idles, polling `lsof -t` every 30 s without sourcing `secrets.env`, and
`exec`s `tern daemon --socket …` once no process owns the socket. A stale
socket file with no owner does not block it. `KeepAlive` still restarts the
job after a crash. Inspect live process ownership rather than inferring it from
the installed plist. Web-only activation leaves both daemon services alone.

A changed wrapper makes the loaded daemon plist differ, so full activation
refuses it by design. Between Tern turns, with no job-owned daemon running,
run `launchctl bootout "gui/$(id -u)/org.nixos.tern-pilot-daemon"` and then
full `tern-pilot-activate`. Booting out a job that owns the daemon may
interrupt its panes; an app-owned daemon is not affected.

Account and session data are shared with the native app, not placed in a
second profile. Withdrawal re-enables the bundled service. Do not enable it
independently while the pilot daemon owns the socket.

Private paths:

- Native configuration/account/session state: `~/Library/Application Support/Tern/`.
- Bearer token: `~/.local/state/tern-pilot/web-token` (generated once, mode 0600).
- Logs: `~/.local/state/tern-pilot/logs/{daemon,web,gateway,tailnet}.{out,err}` (0600).
- Nix GC roots: `~/.local/state/tern-pilot/gcroots/`; activation roots its
  store closure so automatic GC cannot remove the live scripts before a switch.
- Phone connection: `~/.local/state/tern-pilot/phone-connection.json` (0600),
  written by the gateway launcher. Its `url` is the plain HTTPS origin,
  without credentials. Keep the private machine URL out of this public repo.
  Its existence alone does not prove the service or Serve route is ready.

The web launcher uses the configured arguments:

```text
web serve --listen 127.0.0.1:8377 --token <private-token-file> --assets <selected-assets-directory>
  --allow-origin http://127.0.0.1:8377 --allow-origin https://<mac-magicdns-name>:8377
```

MagicDNS and the owning user's login are derived locally from
`tailscale status --json`; neither private value is stored in the repository.
The route is
`tailscale serve --bg --yes --https=8377 http://127.0.0.1:18377`.
The gateway requires one owner-matching `Tailscale-User-Login` header for all
HTTP and WebSocket requests, plus the exact HTTPS Origin for `/wire` upgrades.
[Tailscale Serve strips spoofed identity headers and supplies the authenticated
requester's identity](https://tailscale.com/docs/features/tailscale-serve#identity-headers).
Only loopback can reach the gateway; local processes are within that trust
boundary. Missing identity, tagged clients and other users fail closed.
The backend bearer token stays private and is injected only server-side.
No browser login or secret URL transfer is required. This pilot enables
**no Funnel** and starts no QUIC/iroh server.

## Sessions

Tern's daemon owns panes and their authoritative screen; clients mirror the
same live terminal, rather than resuming a separate agent from a transcript.
Closing a client window does not normally end daemon-owned panes. See the
[architecture](https://docs.stencil.so/tern/concepts/architecture.md) and
[sessions/blocks](https://docs.stencil.so/tern/scripts/sessions.md) docs.

An omp already running in Ghostty is **not imported** into Tern. To reach an
existing tmux session, open a Tern shell pane and run `tmux attach -t <existing-session>` to
reach an existing tmux PTY. This is the ANSI fallback path, not native
Tern Surface Protocol rendering. For native integration, start `omp` directly
in a Tern pane (or a Tern agent block); its terminal probe must reach Tern
without tmux in between. Native rendering requires Stencil-account sign-in;
browser rendering requires the matching browser bundle. See the
[protocol reference](https://docs.stencil.so/tern/protocol/index.md).

Do not resume the same transcript in a second omp while its original owner is
still running: two writers can conflict. Mirroring one Tern-owned process is
different from starting another process.

The Mac must remain powered, reachable and awake. Tern owns keep-awake through
`org.nixos.tern-pilot-awake`, running `/usr/bin/caffeinate -i`. Caffeinate does not
guarantee closed-lid operation: use an open lid or a supported powered clamshell
setup, and account for sleep, network changes and reboot before relying on
remote access.

## Inspect and withdraw

`tern-omp-status` is available in the built pilot's `bin/` and Home Manager packages:

- Compares build-time declarations with installed omp extensions/MCP, managed Tern settings, app/web assets, and the actual socket owner versus launchd's job.
- Flags checkout changes since the build; rebuild before trusting a match. Exit 1 means detected drift; runtime model roles are excluded.
- Reports unobservable runtime configuration and gateway assets as unknown. Read-only: no file contents, environment or credentials printed, and no repairs or restarts.

Inspect service status locally without dumping tokens or account files:

```sh
for label in org.nixos.tern-pilot-daemon org.nixos.tern-pilot-web org.nixos.tern-pilot-gateway org.nixos.tern-pilot-tailnet org.nixos.tern-pilot-awake; do
  launchctl print "gui/$(id -u)/$label"
done
curl --fail --silent --output /dev/null http://127.0.0.1:8377/
```

A successful root request is only a local asset-serving check, not a phone or
omp smoke test. Inspect the private logs locally as needed; review/redact them
before sharing because terminal output and runtime errors may contain secrets.
Do not automatically print `web-token`, `phone-connection.json`, account state
or `secrets.env` during diagnosis.

Gateway security regressions use fictional tokens and isolated loopback
fixtures:

```sh
node --test darwin/tern/gateway-test.mjs
```

Finish ongoing Tern work before withdrawal. Unload only the pilot labels and
remove their plist files so they are not bootstrapped at the next login:

```sh
for label in org.nixos.tern-pilot-tailnet org.nixos.tern-pilot-gateway org.nixos.tern-pilot-web org.nixos.tern-pilot-daemon org.nixos.tern-pilot-awake; do
  launchctl bootout "gui/$(id -u)/$label"
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
done
launchctl enable "gui/$(id -u)/so.stencil.tern.daemon"
/run/current-system/sw/bin/tailscale serve --https=8377 off
```

A missing/unloaded label can make `bootout` report an error; still explicitly
remove the persisted **8377-only** Serve route. Do not use a global Serve reset
or touch unrelated routes. The separate bundled `so.stencil.tern.daemon` is
re-enabled for normal native-app startup, not removed. AbandonProcessGroup
means unloading the pilot daemon does not promise all pane processes terminate.

Preserve configuration, tokens, logs, transcripts, web assets and the app for
inspection or later reuse. Pilot withdrawal does not uninstall the app or
remove state. A later full Darwin switch or explicit pilot activation can
reintroduce these declared services.

The installed CLI link and its private shell environment also remain available.
To withdraw that PATH preference, remove
`~/.local/state/tern-pilot/cli-env.zsh` and its guarded source line from
`shell/local.zsh`; preserve unrelated private shell customizations.
