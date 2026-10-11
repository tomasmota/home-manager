# Tern pilot: purpose, checkpoint and next steps

Checkpoint: **2026-10-11**. This records the work and observations from the pilot;
it is not a fresh service-health check. See [README.md](README.md) for build,
activation, private-state handling and withdrawal commands.

## Purpose

Evaluate [Stencil's Rust-native Tern](https://stencil.so/tern) as a possible
replacement for Paseo's laptop-to-phone workflow: start omp on the Mac, control
that same running session from an Android phone on the same tailnet, then return
to the laptop without restarting the agent or creating another transcript writer.

This is a **parallel pilot**, not a terminal cutover. Preserve Ghostty, tmux and
Paseo until the real desktop/phone workflow passes. An existing Ghostty omp is
not automatically imported into Tern. Attaching an existing tmux session is a
possible ANSI bridge; direct omp in a Tern pane is the native Tern Surface
Protocol (TSP) path.

## Where we got

### Installed and configured

- Pinned Mac Apple Silicon Tern **0.7.2**, short commit **5d1cc64**, from the
  supplied official DMG received through Taildrop.
- Installed the app at `~/Applications/Tern.app` and the CLI at
  `~/.local/bin/tern`. Gatekeeper accepted the notarized app; normal app launch
  no longer used App Translocation. System Gatekeeper remains enabled.
- Added `darwin/tern.nix`, imported by `darwin/macos.nix`, plus a private-artifact
  runtime installer, Tern-only activation and installer regression coverage.
- Activated only the pilot, **without a Darwin switch or Paseo restart**.
- Established one daemon owner: `org.nixos.tern-pilot-daemon`. Activation
  disables/unloads the app's competing `so.stencil.tern.daemon` service. Both
  native app and pilot use the normal Tern configuration/session directory.
- Configured private token/logs, Nix GC roots and browser/tailnet launchers.
  Browser access fails closed without real assets. The intended browser path is
  loopback HTTP on 8377 behind tailnet HTTPS on 8377, not public Funnel.

### Exercised verification

- Full Darwin system build and `nix flake check --no-build` passed.
- Four offline installer regressions passed: publication, idempotent retry,
  damaged-release refusal and preservation of an unrelated Applications entry.
- An actual interactive omp **18.8.6** turn returned `42` through native TSP
  surfaces; raw ANSI capture was empty. Repeated under the sole managed daemon.
- Shell state survived daemon ownership transfer and separate CLI clients.
  Normal native-app relaunch retained the managed daemon PID.
- The actual native window displayed the closed-beta sign-in gate.
- At the final service check, Paseo was healthy, its tailnet port **6767** was
  unchanged, no Funnel was enabled and existing idle-sleep prevention remained.
- Temporary model panes and inspection scaffolds were closed/removed. Private
  release artifacts and the ready pilot shell were retained.

**Not verified:** signed-in native terminal rendering, Android rendering,
laptop-to-phone handoff, mobile approval/input handling or post-login service
ownership. Mac-side daemon/TSP proof is not proof of a finished phone pilot.

## Blocking findings

### 1. No usable browser client supplied by the inspected packages

The Mac DMG contains no browser HTML/JavaScript/WASM asset tree. Running the
native web-server command without assets produced a missing-page response.

The additional supplied artifact was **`Tern-0.7.2-linux-arm64.tar.gz`**, not a
Mac ZIP. Two read-only agents inspected it; the Linux executable was never run
on the Mac. The archive contains only `tern/tern`. Its computed SHA256 is:

```text
16f6221a376db1163c897e9328a9f6999f32b0b9d04908da3fc4768ada115617
```

That matches the checksum prefix/suffix supplied from the Stencil build page.
Embedded version/commit markers match 0.7.2 / 5d1cc64. Static inspection found
no uncompressed WebAssembly v1 module headers and identified no usable browser
payload or browser-asset bootstrap mechanism. This does not prove the absence
of every possible compressed payload or undocumented provisioning path.

Most decisively, the binary contains this web-serving diagnostic:

> No web client here: build it with `just tern-web`, or pass --assets DIR.

The archive provides neither source nor a build recipe for `just tern-web`.
The [support matrix](https://docs.stencil.so/tern/concepts/support-matrix.md)
describes a web client, and the product page advertises wasm/WebGPU browser
access, but the supplied build-page listing has no explicit browser-client
artifact. A separate matching downloadable client has not been verified.

**[INFERENCE]** This is likely a beta packaging/release-readiness gap or a
separate distribution channel, rather than a wrong CPU build or tailnet problem.
Do not treat that hypothesis as confirmation from Stencil. Do not substitute
another product, fake page or arbitrary browser frontend.

### 2. First native Stencil sign-in is pending

The Mac app requires an invited Stencil account. Authentication was not bypassed.
First sign-in and any subsequent provisioning have not been exercised. No
inspected evidence establishes that login downloads the missing browser client.
Browser-side account requirements also remain unverified.

### 3. The phone workflow still needs an end-to-end trial

Even with matching assets, Android browser compatibility and tailnet access to
TCP 8377 need verification. The Mac must stay powered, awake and reachable;
existing caffeinate does not guarantee closed-lid operation or access after a
FileVault reboot before login.

## Other useful findings

- The received Linux archive is ARM64 **glibc**, not musl and not an Android app.
  Embedded 0.7.2 notes explicitly add ARM64 musl support for Alpine and similar
  hosts. “musl” names a Linux C library; it does not mean Linux is mandatory.
- Embedded 0.7.2 notes report a fix for repeatedly rewriting whole scrollbacks
  and omp transcripts while idle.
- Embedded 0.7.0 notes introduce Tern-managed omp installation/background
  updates. Do not enable that during this Nix-managed pilot. Review Tern's own
  updater before using it so it does not bypass the pinned-runtime workflow.
- Agent status/notifications include working, waiting for input, finished and
  failed states. Their usefulness on the phone is still an acceptance check.
- `tern.build` and the Shubham-1994 project are unrelated to Stencil Tern. One
  investigator mixed in those links; their provenance claims were discarded.

## Next steps, in order

1. **Confirm distribution with Stencil.** Establish whether invited 0.7.2 users
   can use the browser client on Android, where the matching `tern-web` assets
   come from, and whether missing assets in these packages are expected. If the
   route requires source access, obtain the real source/build instructions.
   Another desktop archive or a Darwin switch is not an established remedy.
2. **Complete first native sign-in** with the invited account. Observe the real
   app and check that only one daemon owns the shared socket afterward; do not
   independently enable the bundled daemon while the pilot daemon is active.
3. **Inspect and install genuine matching browser assets**, following the
   README's versioned path and private-state rules. Prove the actual browser
   interface works locally before publishing the tailnet route. Keep the token
   and connection URL out of Git, chat, screenshots and shared logs.
4. **Exercise one live omp process across Mac and phone.** Verify shared output,
   typing, scrolling, a real turn, an input/approval interaction, phone reconnect
   and return to the Mac without a second writer. Check Android rendering and
   the actual surfaces, not just HTTP 200 or daemon captures.
5. **Decide whether to adopt Tern only after that proof.** Keep Paseo available
   during a trial with real work. A later full Darwin switch remains deliberate;
   it was not performed for this pilot. If browser distribution is unavailable,
   retain a desktop-only experiment or withdraw using the README rather than
   claiming Tern has replaced the phone workflow.
