# Stencil Tern parallel pilot

This is [Stencil's Rust-native Tern](https://stencil.so/tern), not tern.build.
It runs alongside the existing Paseo, tmux and Ghostty setup; Paseo's port
6767 and current omp installation are unchanged. No full Darwin switch is
needed for the pilot.

See [the pilot checkpoint and next steps](PILOT.md) for the purpose, verified
progress as of 2026-10-11, browser-client blocking findings and adoption criteria.

## Status and prerequisites

The native app has been launched and shows the closed-beta sign-in gate.
Sign in with an invited Stencil account; authentication has not been bypassed.
The inspected macOS DMG contains **no browser HTML/WASM client**. A matching
official web/WASM client is not installed, and a downloadable archive has not
been verified. Check the authenticated Stencil build portal or request it from
Stencil. Install the complete client contents at
`~/.local/share/tern-web/0.7.2/`, with `index.html` directly in that directory.
Use a real directory, not a symlink. The web service refuses to listen without
that file; no replacement page or fake client is supplied.

Verified on this Mac: signed arm64 `tern 0.7.2 (5d1cc64)`, the full Darwin
system build, `nix flake check --no-build`, and Tern-only service activation.
An isolated interactive omp 18.8.6 turn returned `42` through native TSP
surfaces; its raw ANSI capture was empty. The app's actual window displayed
the sign-in gate. Desktop/phone terminal rendering and handoff are **not verified**.
The Mac app still needs Stencil sign-in; Android access needs the missing
browser client and tailnet permission to reach the Mac on TCP 8377.

## Pinned runtime and activation

The private download belongs at `~/.cache/tern/Tern-0.7.2-macos-arm64.dmg`.
Download it after signing in at [the build portal](https://build.stencil.so/tern);
never cache the DMG, browser archive or account data in this public repository.

- Version: **0.7.2**, native Apple Silicon (`arm64`).
- DMG SHA256: `0a3e9ffef15c54202d5c1a5e45d1db0d7ba9d732242f0fea26bebce5cb44c7bd`.
- Bundle: `Tern.app`, identifier `so.stencil.tern`.
- Immutable release: `~/.local/share/tern-runtime/0.7.2-<DMG SHA256>-<installer SHA256>/`.
  Both digests are full SHA256 values. A changed installation recipe publishes
  a fresh release rather than modifying a previously launched app bundle.
- App entry: `~/Applications/Tern.app`, a symlink into that release.
- Real CLI: `Tern.app/Contents/MacOS/tern` inside the release; the package's
  `bin/tern` delegates to it. Activation preserves an app-installed
  `~/.local/bin/tern` link to this same binary, or installs its package link
  when absent. It migrates older pilot-owned links and records ownership in
  `~/.local/state/tern-pilot/cli-target`; unrelated entries are never replaced.

The installer verifies the app signature. If the candidate is quarantined,
Gatekeeper must accept it before its quarantine attribute is removed, before
publication. System Gatekeeper remains enabled. The pinned app passed a
notarized-developer assessment and normal Mac launch without App Translocation.

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

Activation validates/installs the privately cached runtime and bootstraps only
three pilot LaunchAgents. It does not switch Darwin or restart Paseo. Repeating
it accepts identical loaded configuration; differing loaded configuration is
refused so ongoing Tern turns can finish before unloading. Missing web assets
leave browser access blocked even if activation has installed the agents.

Later, a deliberate `sudo darwin-rebuild switch --flake .#macbook` applies the
full Darwin configuration, including this module; it is **not** the pilot
activation path. Upgrades require the actual reviewed release artifact, its
recorded digest, inspected bundle/CLI identity, and corresponding runtime and
web-assets pins. Do not substitute a guessed URL, a login page or an unreviewed
new version for the pinned artifact.

## Services and private state

LaunchAgents live in `~/Library/LaunchAgents/` as `<label>.plist` and run in the
owning user's GUI launchd domain:

| Label | Behavior |
| --- | --- |
| `org.nixos.tern-pilot-daemon` | `tern daemon`; RunAtLoad, KeepAlive, Interactive, 5-second throttle, AbandonProcessGroup to preserve pane PTYs on daemon exit. |
| `org.nixos.tern-pilot-web` | RunAtLoad, KeepAlive, Standard, 60-second throttle; requires genuine assets and Tailscale MagicDNS identity. |
| `org.nixos.tern-pilot-tailnet` | RunAtLoad; retries unsuccessful exits at a 60-second throttle. Adds the HTTPS route only after a successful loopback root GET. |

All three use umask 077. Daemon/web work from the home directory. They set
`TERN_CONFIG_DIR` to `~/Library/Application Support/Tern` and `STENCIL_LOG_DIR`
to `~/.local/state/tern-pilot/logs`, with the configured shell/PATH and XDG
locations. The daemon silently sources the repository's gitignored
`secrets.env` for the existing omp environment; a failed load stops startup.
Do not inspect or copy that file into reports.

The app also registers `so.stencil.tern.daemon`. Pilot activation disables and
unloads that bundled service so the configured Nix job alone owns the default
daemon socket. Account and session data are shared with the native app, not
placed in a second profile. Withdrawal re-enables the bundled service.
Normal native-app relaunch retained the managed daemon PID without reloading
the bundled service. The native omp `42` turn was repeated under this owner.
Post-sign-in behavior remains unverified; do not enable the bundled service
independently while the pilot daemon is active.

Private paths:

- Native configuration/account/session state: `~/Library/Application Support/Tern/`.
- Bearer token: `~/.local/state/tern-pilot/web-token` (generated once, mode 0600).
- Logs: `~/.local/state/tern-pilot/logs/{daemon,web,tailnet}.{out,err}` (0600).
- Nix GC roots: `~/.local/state/tern-pilot/gcroots/`; activation roots its
  store closure so automatic GC cannot remove the live scripts before a switch.
- Phone connection: `~/.local/state/tern-pilot/phone-connection.json` (0600),
  written by the web launcher after its prerequisites pass. Its `url` contains
  the bearer token: **never put the file or URL in Git, chat, screenshots or
  shared logs**. Its existence alone does not prove the service is ready.

The web launcher uses the configured arguments:

```text
web serve --listen 127.0.0.1:8377 --token <private-token-file> --assets <selected-assets-directory>
  --allow-origin http://127.0.0.1:8377 --allow-origin https://<mac-magicdns-name>:8377
```

MagicDNS is derived locally from `tailscale status --json`; no private hostname
is stored in the repository. The route is
`tailscale serve --bg --yes --https=8377 http://127.0.0.1:8377`.
The trust boundary is both the bearer token and tailnet access to HTTPS 8377;
anyone holding the token with network access must be treated as a terminal
operator. This pilot enables **no Funnel** and starts no QUIC/iroh server.
After matching assets are installed and services are healthy, privately
transfer the connection URL to the Android browser on the same tailnet. Avoid
sharing or automatically printing it; phone operation and any browser-side
account gate remain unverified.

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
for label in org.nixos.tern-pilot-daemon org.nixos.tern-pilot-web org.nixos.tern-pilot-tailnet; do
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

Finish ongoing Tern work before withdrawal. Unload only the pilot labels and
remove their plist files so they are not bootstrapped at the next login:

```sh
for label in org.nixos.tern-pilot-tailnet org.nixos.tern-pilot-web org.nixos.tern-pilot-daemon; do
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
