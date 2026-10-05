#!/usr/bin/env bash
# Usage: merge-config.sh PREFERENCES POLICY TARGET
#
# Rebuilds omp's config.yml as PREFERENCES * live TARGET * POLICY (yq deep
# merge, later wins, arrays replace). Preferences only fill keys the live file
# lacks, so roles/theme changed through the TUI or `omp config set` survive a
# switch; POLICY keys are reapplied every time. An unreadable live file is kept
# aside as config.yml.invalid rather than silently discarded.
set -euo pipefail

prefs=$1
policy=$2
target=$3
dir=$(dirname "$target")
mkdir -p "$dir"

live=$(mktemp)
tmp=
trap 'rm -f "$live" ${tmp:+"$tmp"}' EXIT

if [ -s "$target" ] && yq -e 'tag == "!!map"' "$target" >/dev/null 2>&1; then
  # omp leaves empty parents such as `compaction:`; null would erase defaults.
  yq 'del(.. | select(tag == "!!null"))' "$target" >"$live"
else
  echo '{}' >"$live"
  if [ -s "$target" ]; then
    mv -f "$target" "$target.invalid"
  fi
fi

tmp=$(mktemp "$dir/.config.yml.XXXXXX")
yq eval-all '. as $doc ireduce ({}; . * $doc)' "$prefs" "$live" "$policy" >"$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$target"
tmp=
