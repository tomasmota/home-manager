#!/usr/bin/env bash
# Build the Codex Usage menu bar app with the system Swift toolchain and
# install it as ~/Applications/CodexUsage.app. Restarts a running instance
# (launchd KeepAlive picks it back up).
set -euo pipefail

cd "$(dirname "$0")"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

SCRATCH="${XDG_CACHE_HOME:-$HOME/.cache}/codex-usage-build"
swift build -c release --scratch-path "$SCRATCH"

APP_DIR="$HOME/Applications/CodexUsage.app"
mkdir -p "$APP_DIR/Contents/MacOS"
cp "$SCRATCH/release/CodexUsage" "$APP_DIR/Contents/MacOS/CodexUsage"
cp Info.plist "$APP_DIR/Contents/Info.plist"

if pgrep -x CodexUsage >/dev/null 2>&1; then
  pkill -x CodexUsage || true
  # Wait for the old instance to fully exit so the single-instance guard in
  # the new one doesn't see it and exit too.
  for _ in $(seq 1 50); do
    pgrep -x CodexUsage >/dev/null 2>&1 || break
    sleep 0.1
  done
fi
# Relaunch explicitly: launchd's KeepAlive only restarts on crashes, not clean exits.
open "$APP_DIR"

echo "codex-usage installed to $APP_DIR"
