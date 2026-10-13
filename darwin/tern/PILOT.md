# Tern pilot: purpose, status and adoption checks

See [README.md](README.md) for build, activation, private-state handling and
withdrawal commands.

## Purpose

Evaluate [Stencil's Rust-native Tern](https://stencil.so/tern) as a possible
replacement for Paseo's laptop-to-phone workflow: start omp on the Mac, control
that same running session from an Android phone on the same tailnet, then return
to the laptop without restarting the agent or creating another transcript writer.

This is a **parallel pilot**, not a terminal cutover. Preserve Ghostty, tmux and
Paseo until the adoption checks below pass on a physical phone. An existing
Ghostty omp is not automatically imported into Tern. Attaching an existing tmux
session is a possible ANSI bridge; direct omp in a Tern pane is the native Tern
Surface Protocol (TSP) path.

## Status: blocked by mobile scrolling

omp is not usable from the phone:

- Scrolling up through the conversation does not work.
- The right-hand scrollbar is unusable on touch; interacting with it opens
  the software keyboard unexpectedly.
- Other mobile usability issues remain, but transcript scrolling is the
  primary blocker.

Desktop-browser rendering at phone dimensions does not prove touch scrolling
or keyboard/focus behavior. No root cause or workaround is known. Report the
symptom in the [public Tern tracker](https://github.com/stencil-hq/tern-sdk/issues)
if no matching issue exists.

## Adoption checks

Before replacing the existing phone workflow, verify on a physical Android
phone that:

- A finger swipe scrolls backward and forward through a long omp conversation,
  making earlier messages readable without opening the software keyboard.
- Scrolling and scrollbar interaction do not steal composer focus; deliberate
  composer focus opens the keyboard and allows typing and a real omp turn.
- One live omp process supports shared output, an input/approval interaction,
  phone reconnect and return to the Mac without a second transcript writer.
