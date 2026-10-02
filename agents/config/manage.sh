#!/usr/bin/env bash
# Offline render/check, or deliberate lock update using an existing clean clone.
# Both profiles are rendered, merged and validated before any file is published.
set -euo pipefail
root=$(cd -- "$(dirname "$0")/../.." && pwd)
source=${AGENTS_SOURCE:-$(dirname "$root")/agents}
mode=${1:---check}
lock="$root/agents/config/lock.json"
revision=
if [ "$mode" = --update ]; then
  revision=${2:?full central SHA required}
  [[ $revision =~ ^[0-9a-f]{40}$ ]] || exit 1
elif [[ $mode != --render && $mode != --check ]]; then
  exit 1
else
  revision=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).revision' "$lock")
fi
test "$(git -C "$source" rev-parse HEAD)" = "$revision"
test -z "$(git -C "$source" status --porcelain --untracked-files=normal)"
node --input-type=module - "$lock" "$revision" "$source" "$root" "$mode" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const [lockPath, revision, source, root, mode] = process.argv.slice(2);
const lock = JSON.parse(fs.readFileSync(lockPath));
if (mode === '--update') lock.revision = revision;
const { render, apply } = await import(source + '/config/render.mjs');
const merged = new Map();
const protectedPaths = new Set([path.resolve(lockPath)]);
for (const profile of ['mac', 'linux']) {
  const adapterPath = path.join(root, 'agents/config', profile + '.json');
  const adapter = JSON.parse(fs.readFileSync(adapterPath));
  protectedPaths.add(path.resolve(adapterPath));
  for (const input of [adapter.server, adapter.instructions, adapter.cli]) if (input) protectedPaths.add(path.resolve(root, input));
  const outputs = await render(lock, adapter, root, source);
  for (const [output, content] of outputs) {
    const previous = merged.get(output);
    if (previous && !previous.equals(content)) throw new Error('profiles render conflicting shared output: ' + output);
    merged.set(output, content);
  }
}
for (const output of merged.keys()) {
  if (protectedPaths.has(path.resolve(root, output))) throw new Error('output collides with an adapter, input or lock: ' + output);
}
await apply(merged, root, mode === '--check');
if (mode === '--update') fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
console.log('agents render: ' + (mode === '--check' ? 'verified' : 'generated') + ' ' + merged.size + ' artifacts at ' + revision);
JS
