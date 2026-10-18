# Tern workflow and phone checks

See [README.md](README.md) for build, activation, private-state handling and
withdrawal commands.

## Purpose

[Stencil's Rust-native Tern](https://stencil.so/tern) is the omp interface:
start omp on the Mac, control that same running session from an Android phone
on the same tailnet, then return to the laptop without restarting the agent or
creating another transcript writer.

An existing Ghostty omp is not automatically imported into Tern. Attaching an existing tmux
session is a possible ANSI bridge; direct omp in a Tern pane is the native Tern
Surface Protocol (TSP) path.

Desktop-browser emulation at phone dimensions does not validate touch
scrolling or keyboard/focus behavior; use a physical phone. Track current
blockers in the [upstream Tern tracker](https://github.com/stencil-hq/tern-sdk/issues), not this repository.

## Phone checks

Verify on a physical Android phone that:

- A finger swipe scrolls backward and forward through a long omp conversation,
  making earlier messages readable without opening the software keyboard.
- Scrolling and scrollbar interaction do not steal composer focus; deliberate
  composer focus opens the keyboard and allows typing and a real omp turn.
- One live omp process supports shared output, an input/approval interaction,
  phone reconnect and return to the Mac without a second transcript writer.
