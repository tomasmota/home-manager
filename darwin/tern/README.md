# Stencil Tern

This is [Stencil's Rust-native Tern](https://stencil.so/tern), not tern.build.
Tern is the native omp interface on Mac. Activation does not need a full
Darwin switch; command and service names retain the `tern-pilot` prefix.

## Prerequisites

Install Tern normally at `/Applications/Tern.app` (Apple Silicon release from
Stencil). Nix never installs, pins or modifies it.

## Runtime and activation

[`runtime/default.nix`](runtime/default.nix) only points at the stable binary
`/Applications/Tern.app/Contents/MacOS/tern` and provides an unversioned `tern`
wrapper for it. The daemon and `tern` CLI use that binary, so updating the app
normally updates them on the next process start.

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

Full activation bootstraps the pilot daemon LaunchAgent. It does not install or
modify the app or switch Darwin. Repeating it accepts identical
configuration; differing loaded configuration is refused so ongoing Tern turns
can finish before the daemon owner changes. Settings and these conflicts are
checked before the native daemon is disabled.

A `sudo darwin-rebuild switch --flake .#macbook` also applies this module, but
it is not the pilot activation path.

### Upgrades

Update `/Applications/Tern.app` normally; replacing it does not update
already-running app or daemon processes.

1. Finish active Tern work first; restarting the daemon may interrupt programs
   and replace shell state.
2. Quit the old native app and reopen `/Applications/Tern.app`. If the daemon
   still runs the old build, use Tern's **Restart session daemon** command.
3. Check `tern --version` and the service status (see Inspect and withdraw).

## Keyboard settings

Darwin activation and `tern-pilot-activate` run `tern-settings-apply`,
which merges the native `tern` preset and explicit Ctrl+Space sequences from
[`tern.nix`](../tern.nix) into Tern's writable `settings.json`. These
[user bindings](https://docs.stencil.so/tern/guides/commands.md#keymap-layering)
override native defaults without a preset-specific prefix setting; unrelated
UI preferences survive. To apply only these settings from a built pilot, run
`<returned-store-path>/bin/tern-settings-apply`, then use Tern's **Reload
settings** command; no service restart or Darwin switch is needed.

Native bindings beyond tabs and panes: `Ctrl+Space i` opens the inbox and
`Ctrl+Space g` opens a new Git block.

`Ctrl+Space Tab` toggles between the current and last-used
session via the [`session-navigation`](session-navigation) window plugin; picker
switches update the pair too. History starts fresh after a plugin reload.
It switches by exact name to avoid Tern's numeric-ID truncation; keep session names unique.
`tern-settings-apply` links it into Tern's plugin directory; reload with
`tern plugin reload`, without restarting the daemon.

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
The local [window-load patch](tern-kube-window-load.patch) stages heavy imports across callbacks to stay within Tern's 50 ms window budget.
Use trusted kubeconfigs and manifests; mutation previews and secret masking are advisory, not security guarantees.

## Scheduled agents

Home Manager pins [Agent Scheduler](https://github.com/bmanturner/tern-agent-scheduler) in `darwin/tern.nix`; open its manager with `Ctrl+Alt+Shift+M` or **Agent Scheduler: Open manager** in the command palette.
Set **Settings › Setup › omp** to `/etc/profiles/per-user/tomas/bin/omp` for Nix-managed omp; jobs and settings stay writable in Tern's `plugin-data/tern-agent-scheduler/`.

## Services and private state

`org.nixos.tern-pilot-daemon` is the only Nix-managed LaunchAgent and runs in the
owning user's GUI launchd domain. Its `AbandonProcessGroup` setting keeps
launchd from killing the remaining process group on exit but does not
guarantee uninterrupted panes.

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
the installed plist.

A changed wrapper makes the loaded daemon plist differ, so full activation
refuses it by design. Between Tern turns, with no job-owned daemon running,
run `launchctl bootout "gui/$(id -u)/org.nixos.tern-pilot-daemon"` and then
full `tern-pilot-activate`. Booting out a job that owns the daemon may
interrupt its panes; an app-owned daemon is not affected.

Account and session data are shared with the native app, not placed in a
second profile. Withdrawal re-enables the bundled service. Do not enable it
independently while the pilot daemon owns the socket.

Native phone remoting belongs to Tern's app-installed `so.stencil.tern.remote`
LaunchAgent, separate from the session daemon. Do not also launch `tern remote serve`
manually or through an omp background job; it competes for the same listener.

Private paths:

- Native configuration/account/session state: `~/Library/Application Support/Tern/`.
- Logs: `~/.local/state/tern-pilot/logs/daemon.{out,err}` (0600).
- Nix GC roots: `~/.local/state/tern-pilot/gcroots/`; activation roots its
  store closure so automatic GC cannot remove the live scripts before a switch.

## Sessions

Tern's daemon owns panes and their authoritative screen; clients mirror the
same live terminal, rather than resuming a separate agent from a transcript.
Closing a client window does not normally end daemon-owned panes. See the
[architecture](https://docs.stencil.so/tern/concepts/architecture.md) and
[sessions/blocks](https://docs.stencil.so/tern/scripts/sessions.md) docs.

Start `omp` directly in a Tern pane or agent block for native Surface Protocol
rendering. Native rendering requires Stencil-account sign-in; see the
[protocol reference](https://docs.stencil.so/tern/protocol/index.md).

Do not resume the same transcript in a second omp while its original owner is
still running: two writers can conflict. Mirroring one Tern-owned process is
different from starting another process.

## Inspect and withdraw

`tern-omp-status` is available in the built pilot's `bin/` and Home Manager packages:

- Compares build-time declarations with installed omp extensions/MCP, managed Tern settings, the installed app, and the actual socket owner versus launchd's job.
- Flags checkout changes since the build; rebuild before trusting a match. Exit 1 means detected drift; runtime model roles are excluded.
- Reports unobservable runtime configuration as unknown. Read-only: no file contents, environment or credentials printed, and no repairs or restarts.

Inspect service status locally without dumping tokens or account files:

```sh
launchctl print "gui/$(id -u)/org.nixos.tern-pilot-daemon"
```

Inspect the private logs locally as needed; review/redact them before sharing
because terminal output and runtime errors may contain secrets. Do not
automatically print account state or `secrets.env` during diagnosis.

Finish ongoing Tern work before withdrawal. Unload the pilot daemon and remove
its plist file so it is not bootstrapped at the next login:

```sh
launchctl bootout "gui/$(id -u)/org.nixos.tern-pilot-daemon"
rm -f "$HOME/Library/LaunchAgents/org.nixos.tern-pilot-daemon.plist"
launchctl enable "gui/$(id -u)/so.stencil.tern.daemon"
```

The separate bundled `so.stencil.tern.daemon` is re-enabled for normal
native-app startup, not removed. AbandonProcessGroup means unloading the
pilot daemon does not promise all pane processes terminate.

Preserve configuration, logs, transcripts and the app for inspection or later
reuse. Pilot withdrawal does not uninstall the app or remove state. A later
full Darwin switch or explicit pilot activation can reintroduce the daemon service.

The installed CLI link and its private shell environment also remain available.
To withdraw that PATH preference, remove
`~/.local/state/tern-pilot/cli-env.zsh` and its guarded source line from
`shell/local.zsh`; preserve unrelated private shell customizations.
