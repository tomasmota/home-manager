# Stencil Tern parallel pilot

This is [Stencil's Rust-native Tern](https://stencil.so/tern), not tern.build.
It runs alongside the existing Paseo, tmux and Ghostty setup; Paseo's port
6767 and current omp installation are unchanged. No full Darwin switch is
needed for the pilot.

See [the pilot checkpoint](PILOT.md) for current verification, the earlier
browser-packaging blocker and adoption criteria.

## Status and prerequisites

The pinned **0.8.2** release embeds the real browser HTML, JavaScript and icons.
Its matching WASM is distributed separately by Stencil. The complete client is
cached privately at `~/.local/share/tern-web/0.8.2/`, with `index.html` at the
root and the WASM at `pkg/stencil_tern_web_bg.wasm`. The page serves that WASM
locally and retains the signed release's SHA-384 integrity check. The old
0.7.2 missing-client blocker no longer applies to this release.

Verified on this Mac: notarized arm64 `tern 0.8.2 (44c7f76)` installation,
the genuine browser client over loopback and Tailnet HTTPS, and locally served
integrity-checked WASM. Browser keyboard input returned `Darwin:arm64` and
`RESULT:42`; the persistent HTTPS endpoint returned `TAILNET_MAC_WEB:Darwin:42`.
A real omp **18.9.2** / **GPT-6.1-Sol** turn returned `42` from a prompt entered
through that HTTPS browser. Reloading retained the same pane and conversation;
the live reply also rendered at a 412 × 915 phone-sized viewport. Physical
Android operation remains separate acceptance.

The phone entrypoint now uses the plain HTTPS origin, without `?token=`.
An owner-only Tailscale Serve gateway authenticates the requester and injects
the private token into the loopback backend's WebSocket handshake. The browser
never receives that token. The previous bare-origin handoff failed because
the native web server rejected requests with no token.

The web client supports **only its serving machine**. Its Add remote host
dialog explicitly rejects other hosts; multi-host connections belong to the
native Tern app. The Mac browser endpoint and a separate Linux endpoint remain
independent. Native Stencil-account sign-in and omp-provider authentication are
separate from the web server's private bearer token.

The browser upgrade deliberately retained the running native app and daemon
at **0.7.2**. The 0.8.2 web/CLI clients interoperated with that daemon, and all
five original pane IDs and both original process IDs were preserved. This is
not a claim that every 0.8.2 feature works with the older daemon.

## Pinned runtime and activation

The private download belongs at `~/.cache/tern/Tern-0.8.2-macos-arm64.dmg`.
Download it after signing in at [the build portal](https://build.stencil.so/tern);
never cache the DMG, browser archive or account data in this public repository.

- Version: **0.8.2**, native Apple Silicon (`arm64`).
- DMG SHA256: `ec249dd7cfb7e195db4e0170c500f49612874cd4cc4afb0dd23edcda25c9500c`.
- Bundle: `Tern.app`, identifier `so.stencil.tern`.
- Immutable release: `~/.local/share/tern-runtime/0.8.2-<DMG SHA256>-<installer SHA256>/`.
  Both digests are full SHA256 values. A changed installation recipe publishes
  a fresh release rather than modifying a previously launched app bundle.
- App entry: `~/Applications/Tern.app`, a symlink into that release.
- Real CLI: `Tern.app/Contents/MacOS/tern` inside the release; the package's
  `bin/tern` delegates to it. Activation preserves an app-installed
  `~/.local/bin/tern` link to this same binary, or installs its package link
  when absent. It migrates older pilot-owned links and records ownership in
  `~/.local/state/tern-pilot/cli-target`; unrelated entries are never replaced.

Activation also installs `~/.local/state/tern-pilot/cli-env.zsh` (mode 0600)
and adds one guarded source line to the existing gitignored `shell/local.zsh`
hook. It puts only the pinned Tern package ahead of the system profile, so an
older system-installed CLI cannot shadow 0.8.2. Other tools keep their existing
precedence. A fresh interactive login shell verified `tern 0.8.2 (44c7f76)`;
existing shells need to source that environment file or start a new shell.

- Cached browser WASM SHA256:
  `72a34fbce53735ed10afb87737aca9aba773b10b29b9f033d673e5d38607a20b`.
- Its SHA-384 SRI is retained from the installed release's embedded HTML; only
  the WASM URL is changed to the local `/pkg/stencil_tern_web_bg.wasm`.

The installer verifies the app signature. If the candidate is quarantined,
Gatekeeper must accept it before its quarantine attribute is removed, before
publication. System Gatekeeper remains enabled. The 0.8.2 bundle passed a
notarized-developer assessment; the already-running native window was not relaunched.

From the repository, build only the pilot:

```sh
nix build --no-link --print-out-paths .#darwinConfigurations.macbook.config.system.build.ternPilot
```

Use the printed store path, as the owning user **without sudo**:

```sh
<returned-store-path>/bin/tern-pilot-activate
<returned-store-path>/bin/tern --version
open "$HOME/Applications/Tern.app"
```

Full activation validates/installs the privately cached runtime and bootstraps
four pilot LaunchAgents. It does not switch Darwin or restart Paseo. Repeating
it accepts identical configuration; differing loaded configuration is refused
so ongoing Tern turns can finish before a daemon-owner cutover.

For an existing managed daemon with live work, upgrade only browser components:

```sh
<returned-store-path>/bin/tern-pilot-activate --web-only
```

This requires the managed daemon before preflight, does not disable/unload
either daemon service, and replaces only changed web/gateway/tailnet jobs.
It updates the managed CLI and keyboard settings without stopping pane
programs. The running daemon's version is intentionally unchanged. The
authentication repair replaced browser services, not the native app or daemon.

Missing web assets still leave browser access blocked. A fresh installation
uses full activation, not `--web-only`.

Later, a deliberate `sudo darwin-rebuild switch --flake .#macbook` applies the
full Darwin configuration, including this module; it is **not** the pilot
activation path. Upgrades require the actual reviewed release artifact, its
recorded digest, inspected bundle/CLI identity, and corresponding runtime and
web-assets pins. Do not substitute a guessed URL, a login page or an unreviewed
new version for the pinned artifact.

## Keyboard settings

Home Manager activation and `tern-pilot-activate` merge the managed keyboard
settings into Tern's writable `settings.json`. The tmux preset uses
**Ctrl+Space** as its prefix. Unrelated UI preferences and custom bindings
survive activation; the managed preset, prefix and bindings are reapplied.

After Ctrl+Space:

| Key | Action |
| --- | --- |
| `h` / `j` / `k` / `l` | Focus left / down / up / right |
| `v` | Split right |
| `s` | Split down |
| `q` | Close the focused pane |
| `Ctrl+q` | Close the active tab, including all its panes |
| `c` | New tab (unchanged tmux preset default) |

A tmux window corresponds to a Tern tab, not an entire native macOS window.
To apply only these settings from a built pilot, run
`<returned-store-path>/bin/tern-settings-apply`; no service restart or Darwin
switch is needed. Use Tern's **Reload settings** command after an external
settings update.

## Terraform plan plugin

Home Manager installs the SDK's [Terraform plan plugin](https://docs.stencil.so/tern/examples/terraform.html)
as a directory symlink at `~/Library/Application Support/Tern/plugins/terraform`.
`darwin/tern.nix` fetches `stencil-hq/tern-sdk` at revision
`13d3cca8bbd8f055431f8eb3caa434a22e966f8f`, with a fixed source hash.
No `tern plugin install` or `tern plugin link` command is required.

The next normal Home Manager activation (through the Darwin switch above)
installs the link; `tern-pilot-activate` does not activate Home Manager files.
Tern watches its plugin directory; **Reload plugins** or `tern plugin reload`
can also reload it without restarting the daemon. Keep the managed package
read-only; update its Nix revision and hash rather than using Tern to replace it.

The lens handles `terraform plan`, `tofu plan`, and their `-chdir=` forms,
but not `apply`. Plugins, native command output (`command_lenses`), and shell
integration must be enabled; all are enabled by default. Use `-input=false`
or supply required variables so the native view does not cover an input prompt.
The block's **Raw** toggle retains the original plan output.

## Services and private state

LaunchAgents live in `~/Library/LaunchAgents/` as `<label>.plist` and run in the
owning user's GUI launchd domain:

| Label | Behavior |
| --- | --- |
| `org.nixos.tern-pilot-daemon` | `tern daemon`; RunAtLoad, KeepAlive, Interactive, 5-second throttle, AbandonProcessGroup to preserve pane PTYs on daemon exit. |
| `org.nixos.tern-pilot-web` | RunAtLoad, KeepAlive, Standard, 60-second throttle; genuine assets and token-protected loopback backend on 8377. |
| `org.nixos.tern-pilot-gateway` | RunAtLoad, KeepAlive, Standard, 60-second throttle; loopback 18377, owner-only Tailscale identity and exact WebSocket Origin, private backend token injection. |
| `org.nixos.tern-pilot-tailnet` | RunAtLoad; retries unsuccessful exits at a 60-second throttle. Adds the HTTPS route after an authenticated gateway root GET. |

All four use umask 077. Daemon/web/gateway work from the home directory. They set
`TERN_CONFIG_DIR` to `~/Library/Application Support/Tern` and `STENCIL_LOG_DIR`
to `~/.local/state/tern-pilot/logs`, with the configured shell/PATH and XDG
locations. The daemon silently sources the repository's gitignored
`secrets.env` for the existing omp environment; a failed load stops startup.
Do not inspect or copy that file into reports.

The app also registers `so.stencil.tern.daemon`. Full pilot activation disables
and unloads that bundled service so the configured Nix job alone owns the
default daemon socket. Web-only activation leaves both daemon services alone.
Account and session data are shared with the native app, not placed in a
second profile. Withdrawal re-enables the bundled service. Do not enable it
independently while the pilot daemon owns the socket.

The live browser upgrade left the existing 0.7.2 native app and daemon running,
with the 0.8.2 browser attached to their actual sessions. An unverified
in-place daemon-upgrade trigger is not used to risk those pane programs.

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

The bare HTTPS origin attached and a real omp turn returned `TOKENLESS_MAC_OK`.
Browser reload retained that conversation, including at phone dimensions.
Live rejection checks passed for missing identity and a foreign Origin;
Serve stripped a spoofed identity header. Physical Android input,
reconnection and the laptop-to-phone omp handoff remain unverified.

## Sessions and gradual adoption

Tern's daemon owns panes and their authoritative screen; clients mirror the
same live terminal, rather than resuming a separate agent from a transcript.
Closing a client window does not normally end daemon-owned panes. See the
[architecture](https://docs.stencil.so/tern/concepts/architecture.md) and
[sessions/blocks](https://docs.stencil.so/tern/scripts/sessions.md) docs.

An omp already running in Ghostty is **not imported** into Tern. For a gradual
bridge, open a Tern shell pane and run `tmux attach -t <existing-session>` to
reach an existing tmux PTY. This is the ANSI fallback path, not proof of native
Tern Surface Protocol rendering. For native integration, start `omp` directly
in a Tern pane (or a Tern agent block); its terminal probe must reach Tern
without tmux in between. The existing omp version is unchanged. Native TSP
transport and one model turn were verified through the daemon; actual client
rendering still requires sign-in/the browser bundle. See the
[protocol reference](https://docs.stencil.so/tern/protocol/index.md).

Do not resume the same transcript in a second omp while its original owner is
still running: two writers can conflict. Mirroring one Tern-owned process is
different from starting another process. Keep current Ghostty/tmux/Paseo work
intact until a separate pilot session proves the workflow.

The Mac must remain powered, reachable and awake. Reuse Paseo's existing
caffeinate service; no redundant awake service is added. Caffeinate does not
guarantee closed-lid operation: use an open lid or a supported powered clamshell
setup, and account for sleep, network changes and reboot before relying on
remote access.

## Inspect and withdraw

Inspect service status locally without dumping tokens or account files:

```sh
for label in org.nixos.tern-pilot-daemon org.nixos.tern-pilot-web org.nixos.tern-pilot-gateway org.nixos.tern-pilot-tailnet; do
  launchctl print "gui/$(id -u)/$label"
done
curl --fail --silent --output /dev/null http://127.0.0.1:8377/
```

A successful root request is only a local asset-serving check, not a phone or
omp smoke test. Inspect the private logs locally as needed; review/redact them
before sharing because terminal output and runtime errors may contain secrets.
Do not automatically print `web-token`, `phone-connection.json`, account state
or `secrets.env` during diagnosis.

The offline installer regression uses a temporary signed fixture app and DMG;
it does not require beta access or touch real Tern state:

```sh
bash darwin/tern/test-install.sh
```

It passed publication on macOS, retry with a distinct generated-pin timestamp,
damaged-release refusal, and preservation of an unrelated Applications entry.

Gateway security regressions use fictional tokens and isolated loopback
fixtures; all nine groups passed:

```sh
node --test darwin/tern/gateway-test.mjs
```

Finish ongoing Tern work before withdrawal. Unload only the pilot labels and
remove their plist files so they are not bootstrapped at the next login:

```sh
for label in org.nixos.tern-pilot-tailnet org.nixos.tern-pilot-gateway org.nixos.tern-pilot-web org.nixos.tern-pilot-daemon; do
  launchctl bootout "gui/$(id -u)/$label"
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
done
launchctl enable "gui/$(id -u)/so.stencil.tern.daemon"
/run/current-system/sw/bin/tailscale serve --https=8377 off
```

A missing/unloaded label can make `bootout` report an error; still explicitly
remove the persisted **8377-only** Serve route. Do not use a global Serve reset
or touch Paseo's 6767 route. The separate bundled `so.stencil.tern.daemon` is
re-enabled for normal native-app startup, not removed. AbandonProcessGroup
means unloading the pilot daemon does not promise all pane processes terminate.

Preserve configuration, tokens, logs, transcripts, the private cache, web assets
and immutable releases for inspection or later reuse. Pilot withdrawal does
not uninstall the app or remove state. A later full Darwin switch or explicit
pilot activation can reintroduce these declared services.

The installed CLI and its private shell environment also remain available.
To withdraw that PATH preference, remove
`~/.local/state/tern-pilot/cli-env.zsh` and its guarded source line from
`shell/local.zsh`; preserve unrelated private shell customizations.
