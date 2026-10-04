#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd -- "$(dirname "$0")" && pwd)
# macOS TMPDIR may contain /var, a symlink the immutable installer rejects.
scratch_root=$(node -p 'require("fs").realpathSync(require("os").tmpdir())')
mkdir -p "$scratch_root/opencode"
scratch=$(mktemp -d "$scratch_root/opencode/agent-runtime-smoke.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
mkdir "$scratch/home"
export HOME="$scratch/home" npm_config_userconfig=/dev/null npm_config_cache="$scratch/cache"
expected=$(node -e 'const fs=require("fs"),c=require("crypto"),p=process.argv[1];console.log(c.createHash("sha256").update(fs.readFileSync(p+"/package.json")).update(fs.readFileSync(p+"/package-lock.json")).digest("hex"))' "$source_dir")
bash "$source_dir/install.sh" "$source_dir" "$scratch/release" "$expected"
bash "$source_dir/install.sh" "$source_dir" "$scratch/release" "$expected"
echo 'Locked runtime strict installation and idempotent reuse passed (no live activation)'
