#!/usr/bin/env bash
set -euo pipefail
source_dir=$1
destination=$2
expected=$3
test "$#" = 3
actual=$(node -e 'const fs=require("fs"),crypto=require("crypto"); const p=process.argv[1],h=crypto.createHash("sha256"); for(const f of ["package.json","package-lock.json","btw.patch","btw.js"]) h.update(fs.readFileSync(p+"/"+f)); console.log(h.digest("hex"))' "$source_dir")
test "$actual" = "$expected"
case $(npm config get strict-allow-scripts) in
  true|false) ;;
  *) echo 'A runtime npm with strict lifecycle-script allowlisting is required' >&2; exit 1 ;;
esac
verify() {
  local target=$1
  cmp -s "$source_dir/package.json" "$target/package.json"
  cmp -s "$source_dir/package-lock.json" "$target/package-lock.json"
  cmp -s "$source_dir/btw.js" "$target/node_modules/@getpaseo/server/dist/server/server/agent/providers/omp/btw.js"
  patch --dry-run --reverse --batch -p1 -d "$target" -i "$source_dir/btw.patch" >/dev/null
  test "$("$target/node_modules/.bin/paseo" --version)" = "$(node -p 'require(process.argv[1]).dependencies["@getpaseo/cli"]' "$source_dir/package.json")"
  # Install scripts are denied; the shipped darwin-arm64 prebuilds must load as-is.
  node -e 'require(process.argv[1])' "$target/node_modules/node-pty"
  test -x "$target/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
  test "$(node "$target/node_modules/esbuild/bin/esbuild" --version)" = "$(node -p 'require(process.argv[1]).version' "$target/node_modules/esbuild/package.json")"
  npm ls --prefix "$target" --depth=0 >/dev/null
}
node - "$destination" <<'JS'
const fs=require('fs'),path=require('path');
let p=path.resolve(process.argv[2]);
while(true){try{if(fs.lstatSync(p).isSymbolicLink())throw Error('symlink runtime destination rejected')}catch(e){if(e.code!=='ENOENT')throw e}const parent=path.dirname(p);if(parent===p)break;p=parent}
JS
umask 022
mkdir -p "$(dirname "$destination")"
guard="${destination}.install-lock"
mkdir "$guard" || { echo 'Runtime install already locked; inspect the other installer before retrying' >&2; exit 1; }
stage=
trap 'if [ -n "$stage" ]; then rm -rf -- "$stage"; fi; rmdir -- "$guard"' EXIT
if test -e "$destination"; then
  test -d "$destination" && ! test -L "$destination"
  # Never overwrite a damaged immutable release silently.
  verify "$destination"
  exit
fi
stage=$(mktemp -d "${destination}.staging.XXXXXX")
cp "$source_dir/package.json" "$source_dir/package-lock.json" "$stage/"
npm ci --prefix "$stage" --strict-allow-scripts --no-audit --no-fund
patch --batch --fuzz=0 -p1 -d "$stage" -i "$source_dir/btw.patch"
cp "$source_dir/btw.js" "$stage/node_modules/@getpaseo/server/dist/server/server/agent/providers/omp/btw.js"
verify "$stage"
# Cooperating publishers are serialized; never use mv on an existing directory.
! test -e "$destination" && ! test -L "$destination"
mv "$stage" "$destination"
stage=
printf 'Installed locked paseo runtime %s\n' "$expected"
