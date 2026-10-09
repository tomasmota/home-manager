---
name: tmux-control
description: >
  Control interactive terminal programs through tmux. Use for testing and debugging
  interactive CLIs, TUIs, REPLs, prompts, keyboard shortcuts and terminal workflows;
  reproduce startup failures, inspect screen/scrollback and process exit state,
  and send safe, explicitly targeted input in a real PTY.
license: MIT
metadata:
  source: owner-maintained
  verified: '2026-10-07'
---

# tmux control for CLI/TUI testing and debugging

Use existing shell access and tmux, not a new daemon or tool wrapper. A private,
detached tmux server supplies a real PTY even when the assistant runs outside
tmux. Prefer ordinary non-interactive commands when terminal behavior is not
under test. For transferring an agent session, use the specialized handoff skill;
this skill does not change ownership or authorize prompting a successor.

## Targets and ownership

1. Check `command -v tmux` and `tmux -V`. Do not install missing software without
   following the project's package conventions.
2. Choose either an explicitly authorized existing pane or a new isolated test
   server. Do not infer the intended application from the selected pane, window
   title, or inherited `TMUX`/`TMUX_PANE` alone.
3. Record the server/socket and stable IDs returned by creation or discovery.
   Every later command must use that server and an explicit target. `%0` on two
   servers denotes two different panes. Never assume a window starts at index 0.
4. Interrupt, respawn or kill only task-owned processes and containers. Preserve
   user panes, sessions, paste buffers and configuration. Never run an untargeted
   `kill-server` on the user's shared server.

For an authorized existing server, discover before choosing a target:

```sh
tmux list-sessions -F '#{session_id} #{session_name}'
tmux list-panes -a -F '#{session_id} #{window_id} #{pane_id} #{pane_current_command} dead=#{pane_dead}'
# After selecting the intended pane from evidence, not merely the active flag:
tmux display-message -p -t "$pane" '#{pane_id} #{window_id} #{pane_current_command} pid=#{pane_pid} tty=#{pane_tty} dead=#{pane_dead}'
```

For another server, add its `-L "$socket"` or `-S "$socket_path"` to **every**
command, including discovery. Titles and `pane_current_command` are hints, not
proof of the foreground process or application readiness.

## Isolated interactive smoke test

This example exercises a real Python REPL without model/API credentials. Run the
blocks in one dedicated test shell, or save the socket and pane ID between tool calls. Shell
variables do not automatically persist across independent tool invocations.
`python3` must already be available. Substitute the actual CLI/TUI under test.

```sh
socket="cli-smoke-$(date +%s)-$$"
trap 'tmux -L "$socket" kill-server 2>/dev/null || true' EXIT
pane=$(tmux -L "$socket" -f /dev/null new-session -d -P -F '#{pane_id}' -s smoke -x 120 -y 32 /bin/sh)
# Install exit retention before starting the application; fast failures survive.
tmux -L "$socket" set-window-option -t "$pane" remain-on-exit on
# Safe only because this shell was created for this test.
tmux -L "$socket" respawn-pane -k -t "$pane" 'exec python3 -q'
```

`-f /dev/null` isolates tmux configuration, **not** application configuration,
environment, credentials or the filesystem. Use a disposable working directory
(`new-session -c <absolute-directory>`), fixtures and a clean application profile
when needed. Quote the command string for the shell tmux will use; arbitrary
paths/arguments need shell quoting too. Never interpolate untrusted text into
that command. Do not launch a real service against production state for a smoke.

Use bounded checks against observable output, not a long sleep followed by blind
input. This shell helper prints the screen on timeout or premature exit:

```sh
wait_screen() {
  needle=$1
  attempts=0
  while [ "$attempts" -lt 50 ]; do
    screen=$(tmux -L "$socket" capture-pane -p -t "$pane") || return 1
    if printf '%s\n' "$screen" | grep -F -- "$needle" >/dev/null; then return 0; fi
    if [ "$(tmux -L "$socket" display-message -p -t "$pane" '#{pane_dead}')" = 1 ]; then
      printf '%s\n' "$screen"
      return 1
    fi
    attempts=$((attempts + 1))
    sleep 0.1
  done
  printf '%s\n' "$screen"
  return 1
}
wait_screen '>>>' || exit 1
```

A short polling interval is not a readiness assumption. Stop on a failed check;
inspect the screen/exit state before sending anything else. Match fresh output
specific to the transition: an old prompt in scrollback or echoed input can
otherwise produce false success. For this REPL, a new **standalone result line**
is stronger evidence than another occurrence of `>>>`.

```sh
# Literal text and special keys are separate operations.
tmux -L "$socket" send-keys -t "$pane" -l -- '6 * 7'
tmux -L "$socket" send-keys -t "$pane" Enter
wait_screen '42' || exit 1
tmux -L "$socket" capture-pane -p -t "$pane"
# Expect: >>> 6 * 7, then a standalone 42, then the next prompt.

# Debug an application error and recovery to its prompt.
tmux -L "$socket" send-keys -t "$pane" -l -- '1 / 0'
tmux -L "$socket" send-keys -t "$pane" Enter
wait_screen 'ZeroDivisionError' || exit 1
tmux -L "$socket" capture-pane -p -t "$pane"
```

For a TUI, choose a distinctive screen label, send its documented navigation
keys (`Down`, `Up`, `Tab`, `Escape`, etc.), and capture the changed selection or
panel. Exercise the actual behavior, not just pane creation or successful
`send-keys`. A REPL smoke proves PTY/input/error handling, not a different TUI's
rendering or shortcuts.

## Input without accidental execution

- `send-keys -l -- 'text'` sends literal text, including words such as `Enter`.
  Without `-l`, `Enter`, `C-c` and other key names are interpreted as keys.
- Send Enter only after confirming the correct application/prompt is ready.
  A literal newline still reaches the terminal; it may submit a shell command.
- Shell quoting and terminal input are distinct layers. Single-quoted text
  prevents shell expansion; text containing a single quote needs proper quoting
  or a buffer/file. Never place credentials in command arguments, captures or
  saved fixtures.
- For multiline text, create a non-secret UTF-8 file with the file-writing tool,
  then use a uniquely named buffer on the selected server:

```sh
buffer="paste-$$"
tmux -L "$socket" load-buffer -b "$buffer" /absolute/path/to/nonsecret-input.txt
tmux -L "$socket" paste-buffer -p -d -b "$buffer" -t "$pane"
```

`-p` requests bracketed paste when the application enables it; `-d` deletes the
buffer after pasting. **Bracketed paste is not a guarantee against execution.**
Without application support, embedded/trailing newlines may execute immediately.
Use multiline paste only in a known editor/input mode that accepts it, or use the
application's file input instead. If paste fails, delete only your named buffer.
Inspect the resulting input before explicitly submitting where the app permits.

## Observe and debug

```sh
# Current screen, then bounded scrollback (may include sensitive output).
tmux -L "$socket" capture-pane -p -t "$pane"
tmux -L "$socket" capture-pane -p -S -200 -t "$pane"
tmux -L "$socket" display-message -p -t "$pane" \
  '#{pane_id} command=#{pane_current_command} pid=#{pane_pid} tty=#{pane_tty} size=#{pane_width}x#{pane_height} dead=#{pane_dead} status=#{pane_dead_status} signal=#{pane_dead_signal}'
```

- Startup failure: retained dead pane plus screen and `pane_dead_status` expose
  missing binaries, bad flags and configuration errors. `remain-on-exit` must
  be enabled **before** starting the failing program.
- Stalled prompt: capture the screen and inspect process/TTY state first. It may
  be waiting for confirmation, multiline completion, a pager or a password.
  Do not guess by injecting Enter/C-c. `pane_pid` identifies the pane's initial
  process, not necessarily the foreground child; use `ps -p <pid> -o pid=,ppid=,stat=,comm=`
  or TTY-scoped process inspection as supported by the host, without dumping
  environment variables or sensitive argument lists.
- Terminal-specific bug: record dimensions/terminal type, reproduce with the same
  size, and use `resize-window -t <window-id> -x 100 -y 24` on an owned test window
  to check redraw/wrapping. A detached window's size can differ from an attached
  client's. Key behavior and colors may vary by terminal/application.
- `capture-pane` is terminal **text** evidence, not a pixel screenshot. The
  default capture omits styling; `-e` includes escape sequences when needed.
  Screen capture cannot prove color contrast, fonts or browser visuals.
- Pane alive, command name, sent input and a zero exit code are not interchangeable
  with functional success. Check expected output/state and exit status separately.
  If a shell wraps the app without `exec`, the shell can hide the app's exit status.

Exercise exit and startup diagnosis on the owned REPL pane:

```sh
wait_dead() {
  attempts=0
  while [ "$attempts" -lt 50 ]; do
    if [ "$(tmux -L "$socket" display-message -p -t "$pane" '#{pane_dead}')" = 1 ]; then return 0; fi
    attempts=$((attempts + 1))
    sleep 0.1
  done
  tmux -L "$socket" capture-pane -p -t "$pane"
  return 1
}
tmux -L "$socket" send-keys -t "$pane" C-d
wait_dead || exit 1
tmux -L "$socket" display-message -p -t "$pane" 'dead=#{pane_dead} status=#{pane_dead_status}'
# Only after exit is observed; replace the dead task-owned pane with a bad launch.
tmux -L "$socket" respawn-pane -t "$pane" 'exec python3 --not-a-real-option'
wait_dead || exit 1
# Capture the usage/error diagnostic; expect status=2.
tmux -L "$socket" capture-pane -p -t "$pane"
tmux -L "$socket" display-message -p -t "$pane" 'dead=#{pane_dead} status=#{pane_dead_status}'
```

## Stop, clean up and report

Use the application's normal quit first. `C-c` interrupts the foreground program
only when terminal handling allows it; it is input, not guaranteed termination.
Do not kill by a broad process-name match. Escalate only against verified
task-owned processes. Retained dead panes need explicit cleanup.

```sh
# Only the unique private server created above, never the shared user server.
tmux -L "$socket" kill-server
trap - EXIT
```

If testing inside a shared server, close only the panes/windows/sessions created
for this task, by captured IDs. Remove only your fixtures/buffers. On failure,
capture non-sensitive evidence before cleanup; do not leave hidden test servers
running. Report the actual application, scenario, observed output/exit state and
limits. Do not claim another program or GUI was verified.
