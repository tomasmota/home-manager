#!/usr/bin/env bash
set -euo pipefail

# No network/authentication here: use a privately cached, user-downloaded DMG.
# Bundle identity and the CLI path must come from inspection of that pinned DMG.
if [ "$#" -ne 7 ]; then
  printf 'Usage: bash install.sh HOME DMG SHA256 APP_NAME BUNDLE_ID VERSION CLI_PATH_IN_APP\n' >&2
  exit 2
fi
home=$1
source_dmg=$2
expected_sha=$3
app_name=$4
bundle_id=$5
version=$6
cli_path=$7

fail() {
  printf 'Tern runtime: %s\n' "$*" >&2
  exit 1
}

reject_symlink_ancestors() {
  local path=$1
  while :; do
    [ ! -L "$path" ] || fail "Symlink path rejected: $path"
    [ "$path" != / ] || break
    path=$(dirname "$path")
  done
}

clear_assessed_quarantine() {
  local app=$1
  if /usr/bin/xattr -p com.apple.quarantine "$app" >/dev/null 2>&1; then
    # Prevent App Translocation without overriding a failed Gatekeeper decision.
    /usr/sbin/spctl --assess --type execute "$app" || fail 'Gatekeeper rejected the pinned app; quarantine was left intact.'
    /bin/chmod -R u+w "$app"
    if ! /usr/bin/xattr -dr com.apple.quarantine "$app"; then
      /bin/chmod -R a-w "$app"
      fail 'Could not clear quarantine after Gatekeeper accepted the app.'
    fi
    /bin/chmod -R a-w "$app"
  fi
}

[ "$(/usr/bin/uname -s)" = Darwin ] || fail 'This installer requires macOS.'
[ "$(/usr/bin/uname -m)" = arm64 ] || fail 'Run natively on Apple Silicon, not under Rosetta.'
[ "$(/usr/bin/id -u)" -ne 0 ] || fail 'Run as the owning user, without sudo.'
case "$home" in
  /*) ;;
  *) fail 'HOME must be an absolute path.' ;;
esac
case "$home/" in
  *'//'*|*'/../'*|*'/./'*) fail 'HOME must be a normalized absolute path.' ;;
esac
[ -d "$home" ] || fail 'HOME does not exist.'
[ "$(/usr/bin/stat -f %u "$home")" = "$(/usr/bin/id -u)" ] || fail 'HOME belongs to another user.'
[[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || fail 'Supply the independently recorded lowercase SHA256 of the real DMG.'
[ "$version" = 0.8.2 ] || fail 'This installer is pinned to Tern 0.8.2.'
case "$app_name" in
  ''|.*|*/*) fail 'APP_NAME must be the inspected top-level app basename.' ;;
  *.app) ;;
  *) fail 'APP_NAME must end in .app.' ;;
esac
[ -n "$bundle_id" ] || fail 'Supply the inspected CFBundleIdentifier.'
case "$source_dmg" in
  /*) ;;
  *) fail 'DMG must be an absolute path to the private cached download.' ;;
esac
case "$cli_path" in
  ''|/*|../*|*/../*|*/..|./*|*/./*|*/.|*'//'*) fail 'CLI_PATH_IN_APP must be a normalized relative path inside the app.' ;;
esac
[ -f "$source_dmg" ] && [ ! -L "$source_dmg" ] || fail "Missing cached DMG: $source_dmg. Sign in at https://build.stencil.so/tern in your browser, download the invited macOS arm64 build, and cache it outside this repository. A login page is not a DMG."

installer_sha=$(/usr/bin/shasum -a 256 "$0")
installer_sha=${installer_sha%% *}
release_root="$home/.local/share/tern-runtime"
destination="$release_root/$version-$expected_sha-$installer_sha"
applications="$home/Applications"
app_link="$applications/$app_name"
reject_symlink_ancestors "$release_root"
reject_symlink_ancestors "$applications"
umask 022
mkdir -p "$release_root" "$applications"
[ "$(/usr/bin/stat -f %u "$release_root")" = "$(/usr/bin/id -u)" ] || fail 'Runtime directory belongs to another user.'
[ "$(/usr/bin/stat -f %u "$applications")" = "$(/usr/bin/id -u)" ] || fail 'Applications directory belongs to another user.'
lock="$release_root/.install-lock"
mkdir "$lock" || fail "Installation is locked. Inspect the other installer before removing $lock."
stage=
mounted=false
cleanup() {
  local status=$?
  trap - EXIT
  if [ "$mounted" = true ]; then
    if /usr/bin/hdiutil detach "$stage/mount" -quiet; then
      mounted=false
    else
      printf 'Tern runtime: Could not detach image; staging directory retained at %s\n' "$stage" >&2
      status=1
    fi
  fi
  if [ -n "$stage" ] && [ "$mounted" = false ]; then
    # Only this installer-created staging directory is removed. Releases stay intact.
    /bin/chmod -R u+w "$stage"
    /bin/rm -rf -- "$stage"
  fi
  /bin/rmdir "$lock"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Snapshot the mutable cache before verifying it; mount precisely those bytes.
stage=$(mktemp -d "$release_root/.staging.XXXXXX")
/bin/cp "$source_dmg" "$stage/artifact.dmg"
case "$(/usr/bin/file -b "$stage/artifact.dmg")" in
  *HTML*|*html*) fail 'Cached artifact is HTML, probably an authentication redirect. Download the actual DMG after signing in at https://build.stencil.so/tern.' ;;
esac
actual_sha=$(/usr/bin/shasum -a 256 "$stage/artifact.dmg")
actual_sha=${actual_sha%% *}
[ "$actual_sha" = "$expected_sha" ] || fail 'Cached DMG does not match the pinned SHA256; refusing to install or overwrite a release.'
/usr/bin/hdiutil verify "$stage/artifact.dmg" -quiet || fail 'Cached DMG is damaged or is not a valid disk image.'
mkdir "$stage/mount"
/usr/bin/hdiutil attach "$stage/artifact.dmg" -readonly -nobrowse -mountpoint "$stage/mount" -quiet || fail 'Could not attach the verified DMG read-only.'
mounted=true

shopt -s nullglob dotglob
apps=("$stage/mount/"*.app)
[ "${#apps[@]}" -eq 1 ] || fail 'Expected exactly one top-level app bundle in the pinned image.'
[ "${apps[0]}" = "$stage/mount/$app_name" ] || fail 'The app name does not match the inspected release.'
[ -d "${apps[0]}" ] && [ ! -L "${apps[0]}" ] || fail 'The app bundle is not a real directory.'
plist="${apps[0]}/Contents/Info.plist"
[ -f "$plist" ] && [ ! -L "$plist" ] || fail 'The app has no regular Info.plist.'
plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$1" "$plist"
}
[ "$(plist_value CFBundlePackageType)" = APPL ] || fail 'The bundle is not a macOS application.'
[ "$(plist_value CFBundleIdentifier)" = "$bundle_id" ] || fail 'The bundle identifier does not match the inspected release.'
[ "$(plist_value CFBundleShortVersionString)" = "$version" ] || fail 'The app version is not the pinned 0.8.2 release.'
[ "$(plist_value CFBundleVersion)" = "$version" ] || fail 'The app build version is not the inspected 0.8.2 release.'
main_executable=$(plist_value CFBundleExecutable)
case "$main_executable" in
  ''|.*|*/*) fail 'Invalid CFBundleExecutable.' ;;
esac
for executable in "Contents/MacOS/$main_executable" "$cli_path"; do
  [ -f "${apps[0]}/$executable" ] && [ -x "${apps[0]}/$executable" ] && [ ! -L "${apps[0]}/$executable" ] || fail "Missing regular executable in app: $executable"
  [ "$(/usr/bin/lipo -archs "${apps[0]}/$executable")" = arm64 ] || fail "Expected an arm64-only native executable: $executable"
done

candidate="$stage/release"
mkdir -p "$candidate/bin"
/usr/bin/ditto "${apps[0]}" "$candidate/$app_name"
/usr/bin/codesign --verify --deep --strict "$candidate/$app_name" || fail 'Copied app failed code-signature verification.'
clear_assessed_quarantine "$candidate/$app_name"
/bin/ln -s "../$app_name/$cli_path" "$candidate/bin/tern"
printf '%s\n' "$expected_sha" "$app_name" "$bundle_id" "$version" "$cli_path" "$installer_sha" > "$candidate/.release-pin"
# Mutable application state belongs to the user outside this immutable release.
/bin/chmod -R a-w "$candidate"
/usr/bin/hdiutil detach "$stage/mount" -quiet || fail 'Could not detach the disk image before publishing.'
mounted=false

if [ -e "$destination" ] || [ -L "$destination" ]; then
  [ -d "$destination" ] && [ ! -L "$destination" ] || fail 'Existing immutable release is not a regular directory; refusing to overwrite it.'
  [ "$(/usr/bin/stat -f %u "$destination")" = "$(/usr/bin/id -u)" ] || fail 'Existing immutable release belongs to another user.'
  /usr/bin/codesign --verify --deep --strict "$destination/$app_name" || fail 'Existing immutable app failed code-signature verification; refusing to overwrite it.'
  # This generated file has no distribution timestamp. Verify its bytes before
  # matching only the candidate's mtime, so a retry does not look like corruption.
  /usr/bin/cmp -s "$candidate/.release-pin" "$destination/.release-pin" || fail 'Existing release pin differs; refusing to overwrite it.'
  /usr/bin/touch -r "$destination/.release-pin" "$candidate/.release-pin"
  # Compare every file, mode, and symlink with a fresh copy of the pinned image.
  # --dry-run never changes a damaged release, including when extra files exist.
  differences=$(/usr/bin/rsync --dry-run --checksum --recursive --links --perms --delete --itemize-changes "$candidate/" "$destination/")
  [ -z "$differences" ] || fail 'Existing immutable release differs from the pinned DMG; refusing to overwrite it. Inspect it and choose an explicit recovery outside this installer.'
else
  # All cooperating installers hold the same lock; never move into an existing release.
  [ ! -e "$destination" ] && [ ! -L "$destination" ] || fail 'Release appeared during installation.'
  # macOS needs the directory writable to update ".." across parents.
  /bin/chmod u+w "$candidate"
  /bin/mv "$candidate" "$destination"
  /bin/chmod a-w "$destination"
fi

# Keep app discovery separate from immutable release publication. Never replace
# an unrelated app, directory, or link. A conflict leaves the new release intact.
if [ -L "$app_link" ]; then
  old_target=$(/usr/bin/readlink "$app_link")
  if [ "$old_target" != "$destination/$app_name" ]; then
    case "$old_target" in
      "$release_root/"*) ;;
      *) fail "Unrelated Applications link exists: $app_link" ;;
    esac
    old_release=${old_target#"$release_root/"}
    old_release=${old_release%"/$app_name"}
    [[ "$old_release" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{64}(-[0-9a-f]{64})?$ ]] && [ "$old_target" = "$release_root/$old_release/$app_name" ] || fail "Unrelated Applications link exists: $app_link"
    /bin/ln -s "$destination/$app_name" "$stage/app-link"
    # macOS mv -h replaces the symlink itself, not the app directory it points at.
    /bin/mv -fh "$stage/app-link" "$app_link"
  fi
elif [ -e "$app_link" ]; then
  fail "An existing app occupies $app_link; it was left untouched."
else
  /bin/ln -s "$destination/$app_name" "$app_link"
fi
printf 'Installed pinned Tern %s\nCLI: %s\nApp: %s\n' "$version" "$destination/bin/tern" "$app_link"
