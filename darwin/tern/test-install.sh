#!/usr/bin/env bash
# Offline macOS/arm64 regression: a signed fixture app, never the real Tern state.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
scratch=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/tern-installer-test.XXXXXX")" && pwd -P)
trap 'chmod -R u+w "$scratch"; rm -rf -- "$scratch"' EXIT
umask 022
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }
app="$scratch/source/TernFixture.app"
mkdir -p "$app/Contents/MacOS" "$scratch/home"
cat >"$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>so.stencil.tern.installer-fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleExecutable</key><string>tern</string>
<key>CFBundleShortVersionString</key><string>0.8.2</string>
<key>CFBundleVersion</key><string>0.8.2</string>
</dict></plist>
PLIST
printf 'int main(void) { return 0; }\n' >"$scratch/fixture.c"
/usr/bin/clang -arch arm64 "$scratch/fixture.c" -o "$app/Contents/MacOS/tern"
/usr/bin/codesign --force --sign - "$app" 2>"$scratch/sign.log"
/usr/bin/hdiutil create -quiet -volname TernInstallerTest -srcfolder "$scratch/source" -format UDZO "$scratch/fixture.dmg"
sha=$(/usr/bin/shasum -a 256 "$scratch/fixture.dmg")
sha=${sha%% *}
install_fixture() {
  bash "$here/runtime/install.sh" "$1" "$scratch/fixture.dmg" "$sha" \
    TernFixture.app so.stencil.tern.installer-fixture 0.8.2 Contents/MacOS/tern
}
install_fixture "$scratch/home" >"$scratch/install.log" 2>&1 || { cat "$scratch/install.log" >&2; fail 'publishing signed release'; }
release=$(dirname "$(readlink "$scratch/home/Applications/TernFixture.app")")
test "$(/usr/bin/stat -f %Lp "$release")" = 555 || fail 'published release root is read-only'
pass 'publishes a read-only signed release across macOS directory parents'

# Force distinct pin mtimes without timing-dependent sleeps. Retry must preserve
# the existing release, rather than treating generated metadata as corruption.
/usr/bin/touch -t 202001010000 "$release/.release-pin"
stamp=$(/usr/bin/stat -f %m "$release/.release-pin")
before=$(/usr/bin/shasum -a 256 "$release/bin/tern")
install_fixture "$scratch/home" >"$scratch/retry.log" 2>&1 || { cat "$scratch/retry.log" >&2; fail 'idempotent retry'; }
test "$(/usr/bin/stat -f %m "$release/.release-pin")" = "$stamp" || fail 'retry changed installed pin timestamp'
test "$(/usr/bin/shasum -a 256 "$release/bin/tern")" = "$before" || fail 'retry changed installed executable'
pass 'retry accepts identical bytes and preserves existing release metadata'

chmod u+w "$release/TernFixture.app/Contents/MacOS/tern"
printf 'tampered' >>"$release/TernFixture.app/Contents/MacOS/tern"
chmod a-w "$release/TernFixture.app/Contents/MacOS/tern"
tampered=$(/usr/bin/shasum -a 256 "$release/bin/tern")
if install_fixture "$scratch/home" >"$scratch/tampered.log" 2>&1; then fail 'tampered signed release was accepted'; fi
test "$(/usr/bin/shasum -a 256 "$release/bin/tern")" = "$tampered" || fail 'damaged release overwritten'
test ! -e "$scratch/home/.local/share/tern-runtime/.install-lock" || fail 'failed retry retained lock'
pass 'rejects damaged release without overwriting it'

mkdir -p "$scratch/conflict/Applications/TernFixture.app"
printf 'user-owned-app\n' >"$scratch/conflict/Applications/TernFixture.app/sentinel"
if install_fixture "$scratch/conflict" >"$scratch/conflict.log" 2>&1; then fail 'unrelated application replaced'; fi
test "$(cat "$scratch/conflict/Applications/TernFixture.app/sentinel")" = user-owned-app || fail 'unrelated app modified'
test ! -L "$scratch/conflict/Applications/TernFixture.app" || fail 'unrelated app changed to link'
pass 'preserves an unrelated Applications entry'
