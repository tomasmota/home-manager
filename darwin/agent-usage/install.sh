#!/usr/bin/env bash
# Build the flake's store sources with system Swift; stamp source path + version.
# Publish only a signed, verified bundle, then restart through launchd.
# Runtime requires omp with logged-in accounts (`omp usage --json`) only.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd -P)"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

APPS="$HOME/Applications"
APP_DIR="$APPS/AgentUsage.app"
APP_BIN="$APP_DIR/Contents/MacOS/AgentUsage"
STAMP_REL="Contents/Resources/build-stamp"
USER_ID="$(id -u)"
DOMAIN="gui/$USER_ID"
JOB="$DOMAIN/org.nixos.agent-usage"
PLIST="$HOME/Library/LaunchAgents/org.nixos.agent-usage.plist"

STAMP="$SRC
$(swift --version 2>&1)"

bundle_current() {
  [ -x "$APP_BIN" ] \
    && [ "$(cat "$APP_DIR/$STAMP_REL" 2>/dev/null)" = "$STAMP" ] \
    && codesign --verify --strict "$APP_DIR" >/dev/null 2>&1
}

if bundle_current; then
  echo "agent-usage: rebuild skipped (stamp hit): $APP_DIR"
  exit 0
fi

plutil -lint "$SRC/Info.plist" >/dev/null

mkdir -p "$APPS"
WORK="$(mktemp -d "$APPS/.AgentUsage-install.XXXXXX")"
RELOAD=false
cleanup() {
  if "$RELOAD"; then
    if ! launchctl bootstrap "$DOMAIN" "$PLIST" \
      || ! launchctl kickstart -k "$JOB"; then
      echo "agent-usage: could not restart $JOB; the app will start on next login" >&2
    fi
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# Build from a writable copy: the store source is read-only.
cp -R "$SRC/Package.swift" "$SRC/Sources" "$WORK/"
chmod -R u+w "$WORK"
(cd "$WORK" && swift build -c release --scratch-path "$WORK/.build")

NEW="$WORK/AgentUsage.app"
mkdir -p "$NEW/Contents/MacOS" "$NEW/Contents/Resources"
cp "$WORK/.build/release/AgentUsage" "$NEW/Contents/MacOS/AgentUsage"
cp "$SRC/Info.plist" "$NEW/Contents/Info.plist"
printf '%s' "$STAMP" > "$NEW/$STAMP_REL"
# Sign the whole bundle (binds Info.plist and resources), then verify.
codesign --force --sign - "$NEW"
codesign --verify --strict "$NEW"

# Unload before stopping instances so KeepAlive cannot race the bundle swap.
# HM runs in the user's bootstrap context; explicit gui/<uid> also works here.
if launchctl print "$DOMAIN" >/dev/null 2>&1; then
  if [ -f "$PLIST" ]; then
    if launchctl print "$JOB" >/dev/null 2>&1; then
      launchctl bootout "$JOB"
    fi
    RELOAD=true
  elif launchctl print "$JOB" >/dev/null 2>&1; then
    echo "agent-usage: cannot reload $JOB without $PLIST" >&2
    exit 1
  fi

  # Include manually launched copies and instances with command-line arguments.
  pkill -TERM -u "$USER_ID" -x AgentUsage 2>/dev/null || true
  for ((attempt = 0; attempt < 50; attempt++)); do
    pgrep -u "$USER_ID" -x AgentUsage >/dev/null || break
    sleep 0.1
  done
  if pgrep -u "$USER_ID" -x AgentUsage >/dev/null; then
    pkill -KILL -u "$USER_ID" -x AgentUsage
    for ((attempt = 0; attempt < 50; attempt++)); do
      pgrep -u "$USER_ID" -x AgentUsage >/dev/null || break
      sleep 0.1
    done
    if pgrep -u "$USER_ID" -x AgentUsage >/dev/null; then
      echo "agent-usage: could not stop all instances; keeping the previous app" >&2
      exit 1
    fi
  fi
else
  echo "agent-usage: $DOMAIN unavailable; restart deferred until next login" >&2
fi

# Swap in the new bundle; restore the old one if the rename fails.
if [ -e "$APP_DIR" ]; then
  mv "$APP_DIR" "$WORK/previous.app"
  mv "$NEW" "$APP_DIR" || { mv "$WORK/previous.app" "$APP_DIR"; exit 1; }
else
  mv "$NEW" "$APP_DIR"
fi
echo "agent-usage installed to $APP_DIR"

# With no loaded plist, leave startup to nix-darwin/login; never use `open`.
if ! "$RELOAD"; then
  echo "agent-usage: launchd restart deferred until the job is loaded" >&2
fi
