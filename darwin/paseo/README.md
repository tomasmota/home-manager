# Paseo on macOS

[Paseo](https://paseo.sh) lets the Android app drive native `omp` sessions on
this Mac. `darwin/paseo.nix` owns three user launchd agents:

- `org.nixos.paseo` — `paseo daemon run --home ~/.paseo`, loopback
  `127.0.0.1:6767` only. It sources the gitignored `secrets.env` (if present)
  so `omp` gets the same MCP/Inco/Jev environment as the shell.
- `org.nixos.paseo-tailnet` — `tailscale serve --bg --yes --https=6767
  http://127.0.0.1:6767`: tailnet-only HTTPS on port 6767. Funnel is never used.
- `org.nixos.paseo-awake` — `/usr/bin/caffeinate -i` (see Sleep below).

## Trust model

There is no Paseo password. The security boundary is the tailnet:

- Any tailnet peer that Tailscale ACLs allow to reach this Mac on port 6767 can
  control the daemon, i.e. run `omp` with your user's full access.
- Any local process can reach `127.0.0.1:6767` directly.
- The relay is disabled and locked off (`PASEO_RELAY_ENABLED=false`); the
  pinned release admits relay sessions without credentials. Do not enable it.
- Listening is locked to loopback (`PASEO_LISTEN`). Serve forwards the Mac's
  MagicDNS name as `Host`; the daemon wrapper reads `Self.DNSName` from
  `tailscale status` at start and allows exactly that name
  (`PASEO_HOSTNAMES`), so no tailnet name is stored in Git. If Tailscale is not
  ready, the wrapper exits and launchd retries, rather than leaving a daemon
  running that permanently rejects phone requests.

## Runtime and state

`runtime/` pins `@getpaseo/cli` with an integrity-checked lockfile.
System activation (before launchd agents are reloaded) runs `runtime/install.sh`
into an immutable, content-addressed runtime under `~/.local/share/paseo-runtime/`
and verifies it on every switch; the `paseo` command on `PATH` execs it.
Dependency install scripts are denied (`--strict-allow-scripts`) because the
native packages ship prebuilds or resolve their platform package at runtime.
The seed extends `agents.providers.omp.options.rpcTimeoutMs` to give cold starts
time to load extensions and MCP tools.

`~/.paseo` (mode `0700`) is private daemon state. Activation only seeds
`config.json` (`0600`) from `config.json` here when it is missing: loopback
listen, relay off, the `omp` builtin enabled with
`/etc/profiles/per-user/tomas/bin/omp` and every other provider disabled. It
never rewrites an existing file. Pairing keys, server ID and logs stay there;
never copy them to Git, chat or another machine. Connection metadata for the
phone, if kept, belongs in `~/.paseo/` too.

## Connect Android

1. Find this Mac's MagicDNS name locally: `tailscale status --json | jq -r .Self.DNSName`
   (drop the trailing dot).
2. In the Paseo app add a direct host: that name, port `6767`, SSL on,
    password empty. Do not use relay pairing or QR codes.

The Mac cannot reach its own Serve address (`https://<name>:6767` times out
locally); test from another tailnet device.

## Mac desktop client

Use the official Apple Silicon desktop release matching the locked daemon
version. The desktop is a client of this background service, not its owner.
Disable **Manage built-in daemon** in desktop settings; the local workstation
setting is `~/Library/Application Support/Paseo/desktop-settings.json` under
`settings.daemon.manageBuiltInDaemon`.
Restart the desktop app after editing that writable setting outside the UI.

Add a direct connection to `127.0.0.1`, port `6767`, **SSL off**, password
blank. That local HTTP/WebSocket connection differs from Android's HTTPS
connection through Tailscale Serve. Quitting the desktop does not stop launchd.

## Sessions: TUI or phone, not both

Choose **Chat** when opening a workspace, then select **Oh My Pi** in the
composer's model/provider picker. **Profiles** are terminal launchers, not
native chat providers; adding an `omp` terminal profile would not provide the
native phone experience. Use an existing absolute Mac directory path, not a
shell shorthand such as `~`.

Paseo starts its own `omp --mode rpc-ui` processes; it cannot attach to or
monitor the agent in an already-running TUI. Use explicit ownership handoffs:

- TUI to phone: finish or interrupt the current turn, note the transcript path,
  and exit omp. Import it in Paseo, or run
  `paseo import --provider omp --cwd /absolute/project /absolute/session.jsonl`.
- Phone to TUI: finish the turn and **archive** the Paseo agent (or
  `paseo archive <agent-id>`), then `omp --resume /absolute/session.jsonl`.
  Paseo's Stop only interrupts a turn; disconnecting/closing the app also does
  not release the omp process.

Overlapping writers silently fork a stale conversation and can still act
independently on the same project. No global single-process guard is
installed. Native task subagents display as read-only views in Paseo rather
than independent live controllers.

Paseo uses the same omp profile, extensions, skill directories, MCP servers and
auth database as the TUI, including the [session guard](../../agents/omp/README.md#infrastructure-guard).
Full Access uses `yolo`; Always Ask adds native approvals. Changing an existing
session's approval mode restarts its omp process and is refused while a turn runs.

## Side questions with `/btw`

The locked runtime applies `runtime/btw.patch` and installs `runtime/btw.js`
to bridge omp's native BTW RPC API. The patch is part of the runtime identity;
installation rejects mismatched upstream hunks and reverifies the patch and
bridge on subsequent switches. Remove the local patch when a pinned upstream
release provides this integration.

- `/btw <question>` starts a side question while the main task runs, or while idle.
- `/btw` or `/btw --history` shows the session's saved side conversations.
- `/btw --continue <topic-id> <question>` follows up on a topic. Its ID is in the card.
- `/btw --cancel` cancels only the side question, not the main task.

Answers stream into expandable **BTW** cards using the existing client renderer.
They do not enter omp's main model conversation; omp owns their sidecar history.
Only one side question runs at a time. Provider failures appear as failed cards,
not successful empty answers. This does not add the TUI's floating BTW panel.

Patch or bridge changes take effect only after a Home Manager/nix-darwin switch
selects the new runtime; restarting the daemon alone keeps the old one.

## Sleep

`caffeinate -i` prevents idle system sleep on battery and AC. It does not stop
display sleep or screen lock, lid-close sleep (unless clamshell mode with power
and an external display), manual/forced sleep, or low-battery/thermal sleep.
While asleep the phone cannot connect. Check with `pmset -g assertions`.
Keep the Mac powered, online and lid open (or in a supported powered clamshell
setup). These are user-login services: after reboot/FileVault unlock, log in to
start them; screen lock is fine, logout is not.

## Operations

Activation or a daemon restart disconnects clients and interrupts active turns,
and in-flight tool calls and approvals are not transferred: finish or interrupt
them first.

`tailscale serve` from a user agent needs `tomas` as tailscale operator
(`sudo tailscale set --operator=tomas`) unless that is already allowed; the
agent retries every minute and logs to `~/Library/Logs/PaseoTailnet*.log`.

```sh
launchctl kickstart -k "gui/${UID}/org.nixos.paseo"
curl --fail --silent http://127.0.0.1:6767/api/health
tailscale serve status            # :6767 -> 127.0.0.1:6767; leave unrelated routes alone
tailscale funnel status           # must show no Funnel
pmset -g assertions | grep -i caffeinate
bash darwin/paseo/test-install.sh # installer + seed tests in a scratch dir
```

To withdraw tailnet access: remove the module import, switch, then
`tailscale serve --https=6767 off` (tailscaled persists Serve routes).

## Upgrade

Review the release and its install scripts, then in `runtime/` update the exact
version in `package.json`, regenerate the lock with
`npm install --package-lock-only --ignore-scripts`, re-review every lock entry
with `hasInstallScript` and pin each in `allowScripts` (`false` unless its
script is proven necessary), run the test, and switch. Re-check whether relay
authentication is fixed before ever reconsidering the relay.
