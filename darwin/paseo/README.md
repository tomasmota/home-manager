# Paseo on macOS

[Paseo](https://paseo.sh) lets the Android app drive native `omp` sessions on
this Mac. `darwin/paseo.nix` owns three user launchd agents:

- `org.nixos.paseo` — `paseo daemon run --home ~/.paseo`, loopback
  `127.0.0.1:6767` only. It sources the gitignored `secrets.env` (if present)
  so `omp` gets the same MCP/Inco/Jev environment as the shell.
- `org.nixos.paseo-tailnet` — `tailscale serve --bg --yes --https=6767
  http://127.0.0.1:6767`: tailnet-only HTTPS on port 6767. Funnel is never
  used; the existing `:443` Serve entry (OpenChamber) is not touched.
- `org.nixos.paseo-awake` — `/usr/bin/caffeinate -i` (see Sleep below).

OpenCode/OpenChamber are independent of all of this.

## Trust model

There is no Paseo password. The security boundary is the tailnet:

- Any tailnet peer that Tailscale ACLs allow to reach this Mac on port 6767 can
  control the daemon, i.e. run `omp` with your user's full access.
- Any local process can reach `127.0.0.1:6767` directly.
- The relay is disabled and locked off (`PASEO_RELAY_ENABLED=false`); 0.10.3
  relay sessions are admitted without credentials. Do not enable it.
- Listening is locked to loopback (`PASEO_LISTEN`). Serve forwards the Mac's
  MagicDNS name as `Host`; the daemon wrapper reads `Self.DNSName` from
  `tailscale status` at start and allows exactly that name
  (`PASEO_HOSTNAMES`), so no tailnet name is stored in Git. If Tailscale is not
  ready, the wrapper exits and launchd retries, rather than leaving a daemon
  running that permanently rejects phone requests.

## Runtime and state

`runtime/` pins `@getpaseo/cli` 0.10.3 with an integrity-checked lockfile.
System activation (before launchd agents are reloaded) runs `runtime/install.sh`
with Node 24's `npm ci --strict-allow-scripts` into
`~/.local/share/paseo-runtime/<sha256 of package.json + lock>`, then verifies
the immutable release on every switch. All three install scripts are denied:
`node-pty` and `msgpackr-extract` ship darwin-arm64 prebuilds and `esbuild`
resolves its platform package at runtime, so none needs to run. The `paseo`
command on `PATH` execs this runtime. `agents.providers.omp.options.rpcTimeoutMs`
is seeded at 180000 so a cold start can finish loading the existing extensions
and MCP tools.

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

The connection values on this Mac are also saved privately in
`~/.paseo/android-connection.json` (no password or pairing key).

The Mac cannot reach its own Serve address (`https://<name>:6767` times out
locally); test from another tailnet device.

## Mac desktop client

Use the official Apple Silicon desktop release matching the locked daemon
version. The desktop is a client of this background service, not its owner.
Disable **Manage built-in daemon** in desktop settings; the local workstation
setting is `~/Library/Application Support/Paseo/desktop-settings.json` under
`settings.daemon.manageBuiltInDaemon`. It is already disabled on this Mac.
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

Default omp behavior is unchanged: overlapping writers silently fork a stale
conversation, and can still act independently on the same project. No global
single-process guard is installed. Native task subagents display as read-only
views in Paseo rather than independent live controllers.

The existing omp profile, extensions, skill directories, MCP servers and auth
database remain in use. Full Access matches the existing `yolo` policy with
Jev review before execution. Use Always Ask **when creating a new session** if
you want additional native tool approvals. In Paseo 0.10.3, changing approval
mode on an existing omp session warns that a new session is required.

### Verified on this Mac

Initial integration tests used Paseo 0.10.3 and omp 18.6.1:

- External omp session → exit → import → follow-up → archive → external
  resume preserved the session identity, all turns and the original transcript
  prefix, with no duplicate entry IDs. Archive released the provider process.
- A disposable competing-writer test produced a separate session missing the
  other writer's latest turn, confirming that it is not live shared control.
- Native tool approval and question answers passed through Paseo's client API.
  A real Jev review produced an allow decision; a controlled reviewer-failure
  test exercised the existing Jev adapter's manual confirm approve and deny.
- The native runtime exposed 86 active tools, including 71 MCP tools, and seven
  skill commands. No private tool/skill contents are included here.
- Android direct connection over Tailscale HTTPS was confirmed by the user.
  Phone-side rendering/interaction of approval cards still needs a user check.

After host activation installed omp 18.6.3, the native question, Jev manual
approve/deny, MCP/skill inventory checks passed again. A Full Access scratch-file
write completed with a real Jev allow decision and no native approval prompt.
Always Ask is only an additional manual gate: it still prompts after Jev allows.
The existing Jev fallback/exhaustion policy is unchanged (see `omp/README.md`).

All three declared launchd jobs are installed: daemon and sleep inhibitor are
running, and the tailnet route job exits successfully. A daemon stop was followed
by an automatic launchd restart. The deployed wrapper also passed isolated
missing/invalid Tailscale-status, restored-name and broken-secrets-file tests.

OpenCode/OpenChamber were not reconfigured or restarted. Full system activation
is deliberately separate from testing these three new user agents.

## Sleep

`caffeinate -i` prevents idle system sleep on battery and AC. It does not stop
display sleep or screen lock, lid-close sleep (unless clamshell mode with power
and an external display), manual/forced sleep, or low-battery/thermal sleep.
While asleep the phone cannot connect. Check with `pmset -g assertions`.
Keep the Mac powered, online and lid open (or in a supported powered clamshell
setup). These are user-login services: after reboot/FileVault unlock, log in to
start them; screen lock is fine, logout is not.

## Operations

Finish or interrupt active turns before restarting the daemon; this is not a
live transfer of in-flight tool calls or approvals.

`tailscale serve` from a user agent needs `tomas` as tailscale operator
(`sudo tailscale set --operator=tomas`) unless that is already allowed; the
agent retries every minute and logs to `~/Library/Logs/PaseoTailnet*.log`.

```sh
launchctl kickstart -k "gui/${UID}/org.nixos.paseo"
curl --fail --silent http://127.0.0.1:6767/api/health
tailscale serve status            # :443 unchanged, :6767 -> 127.0.0.1:6767
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
