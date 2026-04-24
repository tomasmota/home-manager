---
name: tmux-driver
description: Drive tmux for detached terminal validation. Use when the user asks to run something in tmux, keep an interactive CLI or long-running process alive, inspect pane output, or validate Neovim or another terminal UI without blocking the main shell.
compatibility: Requires local tmux access. Tested on this machine with tmux 3.6a and Neovim 0.12.1.
metadata:
  tested_with:
    tmux: 3.6a
    neovim: 0.12.1
---

# Tmux Driver

## When to Use This Skill

Use this skill when the user asks you to:

- run commands inside `tmux`
- keep a process alive while you inspect output later
- validate interactive CLI, TUI, or Neovim behavior
- inspect pane output after sending keys
- avoid blocking the main shell tool call with a long-running process

Do not use this skill when a normal one-shot shell command is enough.

## Rules

- Start detached sessions you own. Do not attach to or modify the user's existing tmux session unless they explicitly ask.
- Use unique session names such as `agent-<task>-$(date +%s)`.
- Kill only sessions you created.
- Never hardcode pane target `:0.0`. This machine may use nonzero window and pane base indexes.
- Prefer absolute paths for `workdir` and file targets.
- Prefer `tmux send-keys -l` for command text and raw text. Without `-l`, tmux treats tokens as key names and can mangle quotes, backslashes, or shell syntax.
- Use plain `tmux send-keys` only for actual key presses such as `C-m`, `Enter`, `Escape`, or `C-c`.
- For terminal apps, send keys, wait briefly, then inspect with `tmux capture-pane`.
- Full-screen TUIs may switch to alternate screen. On this machine, `tmux capture-pane` can miss useful content there, so verify with pane state and side effects too.

## Core Workflow

### 1. Create isolated session

```bash
session="agent-<task>-$(date +%s)"
workdir="/absolute/path"

tmux new-session -d -s "$session" -c "$workdir"
pane=$(tmux display-message -p -t "$session:" '#{session_name}:#{window_index}.#{pane_index}')
```

Why this shape:

- `-d` keeps session detached
- `-c` sets pane working directory immediately
- `display-message` asks tmux for actual active pane target instead of guessing indexes

### 2. Run one-shot command and wait for completion

Use sentinel text so you know command finished:

```bash
cmd='{ <command>; }; __agent_status=$?; printf "__TMUX_EXIT__:%s\n" "$__agent_status"'
tmux send-keys -l -t "$pane" "$cmd"
tmux send-keys -t "$pane" C-m

for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  out=$(tmux capture-pane -p -t "$pane" -S -200)
  printf '%s\n' "$out" | rg -q '__TMUX_EXIT__:' && break
  sleep 0.5
done

printf '%s\n' "$out"
```

Notes:

- Wrap command in `{ ...; }` so sentinel runs after whole command sequence.
- Prefer assigning complex shell text to `cmd='...'` first, then send with `-l`. This avoids tmux interpreting pieces of the command as special keys.
- Search for `__TMUX_EXIT__:` in captured output. Prompt text and wrapping are noisy.
- Increase `-S -200` if output is longer.

### 3. Start long-running process and poll for ready text

```bash
tmux send-keys -l -t "$pane" "<long-running-command>"
tmux send-keys -t "$pane" C-m

for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  out=$(tmux capture-pane -p -t "$pane" -S -200)
  printf '%s\n' "$out" | rg -q '<ready-text>' && break
  sleep 1
done

printf '%s\n' "$out"
```

When finished, stop process cleanly first:

```bash
tmux send-keys -t "$pane" C-c
sleep 0.5
tmux capture-pane -p -t "$pane" -S -80
```

If pane state is messy after interruption, create a fresh window instead of fighting shell state.

### 4. Create extra windows when tool state should stay separate

```bash
tmux new-window -d -t "$session:" -n nvim -c "$workdir"
pane=$(tmux list-panes -t "$session:=nvim" -F '#{session_name}:#{window_index}.#{pane_index}')
```

Use exact-match window target `:=nvim`. Bare `:nvim` can mis-target or parse badly.

### 5. Drive Neovim or another TUI

Probe pane state before trusting screen captures:

```bash
tmux display-message -p -t "$pane" '#{pane_current_command}|alt=#{alternate_on}|dead=#{pane_dead}'
```

Interpretation:

- `pane_current_command` shows current foreground program.
- `alt=1` usually means full-screen TUI active.
- `dead=1` means pane process exited.

Open file:

```bash
tmux send-keys -l -t "$pane" "nvim path/to/file"
tmux send-keys -t "$pane" C-m
sleep 0.8
tmux display-message -p -t "$pane" '#{pane_current_command}|alt=#{alternate_on}|dead=#{pane_dead}'
tmux capture-pane -a -p -t "$pane" -S -80
```

Edit file:

```bash
tmux send-keys -t "$pane" i
tmux send-keys -l -t "$pane" "first line"
tmux send-keys -t "$pane" Enter
tmux send-keys -l -t "$pane" "second line"
sleep 0.3
tmux display-message -p -t "$pane" '#{pane_current_command}|alt=#{alternate_on}|dead=#{pane_dead}'
tmux capture-pane -a -p -t "$pane" -S -80
```

Save and quit:

```bash
tmux send-keys -t "$pane" Escape
tmux send-keys -l -t "$pane" ":wq"
tmux send-keys -t "$pane" C-m
sleep 0.5
tmux capture-pane -p -t "$pane" -S -40
```

That final capture usually shows shell prompt again, not editor buffer. If you need proof of what was on screen inside Neovim, capture once before `:wq`, but do not rely on capture alone for full-screen TUIs on this machine.

If you only need to exit without saving:

```bash
tmux send-keys -t "$pane" Escape
tmux send-keys -l -t "$pane" ":q!"
tmux send-keys -t "$pane" C-m
```

After save, verify file contents with normal file-reading tools instead of trusting screen alone. For other TUIs, confirm expected state with `pane_current_command`, `alternate_on`, and observable side effects.

## Troubleshooting

- No output yet: wait a little longer, then capture again.
- Wrong pane target: recompute with `display-message` or `list-panes`; do not guess indexes.
- Command text appears but does not run: make sure final key is `C-m`.
- Complex shell syntax got mangled: resend with `tmux send-keys -l`, then send `C-m` separately.
- Pane stuck in interactive mode: send `Escape` for modal editors or `C-c` for shell programs.
- `capture-pane` looks blank for TUI: check `#{pane_current_command}` and `#{alternate_on}` first, then verify side effects such as file writes or command exit.
- Output wraps awkwardly: search for sentinel or key text, not exact visual layout.

## Example Recipes

### Run tests in tmux

```bash
session="agent-tests-$(date +%s)"
workdir="/absolute/path/to/repo"
cleanup() {
  tmux has-session -t "$session" 2>/dev/null && tmux kill-session -t "$session"
}
trap cleanup EXIT
tmux new-session -d -s "$session" -c "$workdir"
pane=$(tmux display-message -p -t "$session:" '#{session_name}:#{window_index}.#{pane_index}')
cmd='{ npm test; }; __agent_status=$?; printf "__TMUX_EXIT__:%s\n" "$__agent_status"'
tmux send-keys -l -t "$pane" "$cmd"
tmux send-keys -t "$pane" C-m
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  out=$(tmux capture-pane -p -t "$pane" -S -200)
  printf '%s\n' "$out" | rg -q '__TMUX_EXIT__:' && break
  sleep 1
done
printf '%s\n' "$out"
```

### Open and edit file in Neovim

```bash
session="agent-nvim-$(date +%s)"
workdir="/absolute/path/to/repo"
cleanup() {
  tmux has-session -t "$session" 2>/dev/null && tmux kill-session -t "$session"
}
trap cleanup EXIT
tmux new-session -d -s "$session" -c "$workdir"
tmux new-window -d -t "$session:" -n nvim -c "$workdir"
pane=$(tmux list-panes -t "$session:=nvim" -F '#{session_name}:#{window_index}.#{pane_index}')
tmux send-keys -l -t "$pane" "nvim --clean path/to/file"
tmux send-keys -t "$pane" C-m
sleep 0.8
tmux display-message -p -t "$pane" '#{pane_current_command}|alt=#{alternate_on}|dead=#{pane_dead}'
tmux send-keys -t "$pane" i
tmux send-keys -l -t "$pane" "edited by tmux"
tmux send-keys -t "$pane" Escape
tmux send-keys -l -t "$pane" ":wq"
tmux send-keys -t "$pane" C-m
sleep 0.5
```

## Cleanup

When done:

```bash
tmux kill-session -t "$session"
```

Safer pattern during multi-step runs:

```bash
cleanup() {
  tmux has-session -t "$session" 2>/dev/null && tmux kill-session -t "$session"
}
trap cleanup EXIT
```

If user wants session left running for later inspection, report session name and pane target explicitly instead of cleaning it up.
