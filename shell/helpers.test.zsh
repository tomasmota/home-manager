#!/usr/bin/env zsh

source "$1"
source "$2"

fail() {
  print -u2 -r -- "FAIL: $*"
  exit 1
}

fixture=$(mktemp -d)
fixture=${fixture:A}
trap 'command rm -rf -- "$fixture"' EXIT
export HOME="$fixture/home"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
mkdir -p "$HOME/dev" "$fixture/start"
cd -- "$fixture/start" || exit 1
start=$PWD

# Use real fd/fzf for selection; model Escape without requiring a terminal.
fzf() {
  if [[ $picker_mode == cancel ]]; then
    command cat >/dev/null
    return 130
  fi
  command fzf --filter="$pick" "$@"
}

nvim() { fail 'editor launched without a selection'; }
tofu() { fail 'tofu launched without a selection'; }

directory="$start/chosen directory's name"$'\n'
repo="$HOME/dev/chosen repo's name"$'\n'
root="$repo/chosen root's name"$'\n'
mkdir -p "$directory" "$root"
git init -q "$repo" || fail 'could not initialize fixture repository'
touch "$root/.terraform.lock.hcl"
print -r -- needle > "$repo/searchable file"
cd -- "$repo" || exit 1

for picker_mode in cancel no-match; do
  pick=does-not-exist-in-fixture
  expected=1
  [[ $picker_mode != cancel ]] || expected=130
  for invocation in cdf cdr nvd nvf nvfh 'nvg needle' _tofu_root cdt tfpt tfat; do
    before=$PWD
    eval "$invocation"
    rc=$?
    [[ $rc == $expected ]] || fail "$invocation returned $rc instead of $expected on $picker_mode"
    [[ $PWD == $before ]] || fail "$invocation changed directory on $picker_mode"
  done
done
print -r -- 'PASS: cancellation and empty selections have no navigation/editor/tofu side effects'

picker_mode=select
cd -- "$start" || exit 1
pick='chosen directory'
cdf || fail 'cdf selection failed'
[[ $PWD == $directory ]] || fail 'cdf damaged the selected path'

pick='chosen repo'
cdr || fail 'cdr selection failed'
[[ $PWD == $repo ]] || fail 'cdr damaged the repository path'

pick='chosen root'
cdt || fail 'cdt selection failed'
[[ $PWD == $root ]] || fail 'cdt damaged the tofu root path'
print -r -- 'PASS: directory, repository and tofu navigation preserve spaces, quotes and trailing newlines'

cd -- "$repo" || exit 1
tofu() {
  [[ $2 == init ]] || fail 'plan/apply ran after failed initialization'
  return 42
}
for invocation in tfpt tfat; do
  eval "$invocation"
  rc=$?
  [[ $rc == 42 ]] || fail "$invocation lost the initialization failure"
  [[ $PWD == $repo ]] || fail "$invocation changed the caller directory"
done
print -r -- 'PASS: failed tofu initialization prevents plan/apply and preserves its exit status'
