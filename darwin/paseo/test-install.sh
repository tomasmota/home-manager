#!/usr/bin/env bash
# Focused tests for runtime/install.sh and the seed config. Installs into a
# scratch directory only; never touches ~/.paseo or ~/.local/share/paseo-runtime.
# Usage: bash darwin/paseo/test-install.sh   (needs Node 24 npm and registry/cache access)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
src=$here/runtime
installer=$src/install.sh
# The installer rejects symlinked ancestors, and macOS /var and /tmp are symlinks.
scratch=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/paseo-runtime-test.XXXXXX")" && pwd -P)
trap 'rm -rf -- "$scratch"' EXIT
export npm_config_cache=${npm_config_cache:-$HOME/.npm}

rev() {
  node -e 'const fs=require("fs"),crypto=require("crypto"); const p=process.argv[1],h=crypto.createHash("sha256"); for(const f of ["package.json","package-lock.json","btw.patch","btw.js"]) h.update(fs.readFileSync(p+"/"+f)); console.log(h.digest("hex"))' "$1"
}
pass() { printf 'ok - %s\n' "$1"; }
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }

revision=$(rev "$src")

dest=$scratch/rt/wrong
if bash "$installer" "$src" "$dest" 0000 >/dev/null 2>&1; then fail 'wrong revision rejected'; fi
test ! -e "$dest" || fail 'wrong revision left no destination'
pass 'wrong revision rejected'

mkdir -p "$scratch/real"
ln -s "$scratch/real" "$scratch/link"
if bash "$installer" "$src" "$scratch/link/$revision" "$revision" >/dev/null 2>&1; then fail 'symlinked destination rejected'; fi
pass 'symlinked destination rejected'

unreviewed=$scratch/unreviewed
mkdir -p "$unreviewed"
cp "$src/package-lock.json" "$unreviewed/"
cp "$src/btw.patch" "$src/btw.js" "$unreviewed/"
node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1])); delete p.allowScripts["node-pty@1.2.0-beta.15"]; fs.writeFileSync(process.argv[2], JSON.stringify(p,null,2)+"\n")' "$src/package.json" "$unreviewed/package.json"
out=$scratch/unreviewed.log
if bash "$installer" "$unreviewed" "$scratch/rt/unreviewed" "$(rev "$unreviewed")" >"$out" 2>&1; then fail 'unreviewed install script blocks install'; fi
grep -q 'ESTRICTALLOWSCRIPTS\|not covered by allowScripts' "$out" || fail 'unreviewed failure is the strict allowlist'
test ! -e "$scratch/rt/unreviewed" || fail 'unreviewed install published nothing'
pass 'unreviewed install script blocks install'

dest=$scratch/rt/$revision
bash "$installer" "$src" "$dest" "$revision" >"$scratch/install.log" 2>&1 || { tail -20 "$scratch/install.log" >&2; fail 'locked install'; }
test "$("$dest/node_modules/.bin/paseo" --version)" = 0.10.3 || fail 'paseo version'
# Denied scripts did not run: esbuild keeps its JS launcher, node-pty has no build output.
test "$(head -c 2 "$dest/node_modules/esbuild/bin/esbuild")" = '#!' || fail 'esbuild postinstall skipped'
test ! -e "$dest/node_modules/node-pty/build" || fail 'node-pty install skipped'
test -z "$(find "$dest" -maxdepth 1 -name '*.staging.*')" && test ! -e "$dest.install-lock" || fail 'no staging leftovers'
pass 'locked install with denied lifecycle scripts'

node -e '
const pty=require(process.argv[1]);
const p=pty.spawn("/bin/echo",["pty-ok"],{});
let out=""; p.onData(d=>out+=d);
p.onExit(({exitCode})=>{ if(exitCode!==0||!out.includes("pty-ok")) process.exit(1) });
' "$dest/node_modules/node-pty" || fail 'node-pty prebuild spawns'
pass 'node-pty prebuild spawns a pty'
PASEO_TEST_RUNTIME="$dest" node --test "$src/btw.test.mjs" || fail 'BTW behavior'
pass 'BTW side conversation behavior'

bash "$installer" "$src" "$dest" "$revision" >/dev/null 2>&1 || fail 'existing runtime reverifies'
pass 'existing runtime reverifies'

printf ' ' >>"$dest/package.json"
if bash "$installer" "$src" "$dest" "$revision" >/dev/null 2>&1; then fail 'tampered runtime rejected'; fi
pass 'tampered runtime rejected'

seedhome=$scratch/home
mkdir -m 700 "$seedhome"
cp "$here/config.json" "$seedhome/config.json"
PATH=$(dirname "$(command -v node)"):$PATH "$dest/node_modules/.bin/paseo" daemon config get --home "$seedhome" >"$scratch/config.json" 2>&1 || fail 'seed config passes strict schema'
node -e '
const cfg=JSON.parse(require("fs").readFileSync(process.argv[1])).value;
const d=cfg.daemon, p=cfg.agents.providers;
const others=["claude","codex","copilot","opencode","pi"];
if(d.listen!=="127.0.0.1:6767"||d.relay.enabled!==false||d.auth) process.exit(1);
if(p.omp.enabled!==true||p.omp.command[0]!=="/etc/profiles/per-user/tomas/bin/omp") process.exit(1);
if(others.some(k=>p[k].enabled!==false)) process.exit(1);
' "$scratch/config.json" || fail 'seed config values'
pass 'seed config accepted by paseo: loopback, relay off, omp only'
