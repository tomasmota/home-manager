# shellcheck shell=bash
# brief: fixed, user-owned context for omp sessions. Packaged by default.nix with
# writeShellApplication (errexit, nounset, pipefail; GNU coreutils, fzf and Git on PATH).
# brief.ts reads the same store and touches $loaded/KEY whenever omp loads a brief.

shopt -s nullglob

store=${XDG_DATA_HOME:-$HOME/.local/share}/briefs
active=$store/active
archive=$store/archive
loaded=${XDG_STATE_HOME:-$HOME/.local/state}/briefs/loaded
tmp=

usage() {
  cat <<'EOF'
Usage: brief COMMAND [ARGS]

  new KEY [-j EPIC] [-m TEXT]
                     Create a brief. -j links a high-level Jira epic
                     (CLOUD-4675) as additional context, not as the work item.
                     A KEY that is a Jira key links itself as the epic.
                     Notes come from -m or stdin; without either, a brief with
                     no link opens $EDITOR on a template.
  edit [KEY]         Edit an active brief in $EDITOR. The link is the
                     "jira: EPIC" line between the "---" lines at the top.
  ls [--all]         List active briefs, most recently used first; --all adds
                     archived ones.
  bind [KEY]         Bind an active brief to this repo; no KEY shows the binding.
  unbind             Remove this repo's default without deleting its brief.
  done [KEY]         Archive an active brief.
  restore [KEY]      Restore an archived brief.
  rm [KEY]           Delete a brief permanently, after confirmation.
  prune [--days N]   Pick briefs not loaded or edited in N days (default 14) and
                     archive them.

A missing KEY opens an fzf picker, except bind (which shows the binding). In omp:
  /brief KEY         Replace the loaded briefs (omit KEY for a picker).
  /brief add KEY     Attach another brief.
  /brief remove KEY  Detach one brief.
  /brief off         Unload all briefs.
Start with several: omp --brief KEY1,KEY2
Repo default: brief bind KEY (stored in local Git config, not committed).
EOF
}

die() {
  printf 'brief: %s\n' "$*" >&2
  exit 1
}

is_jira() {
  [[ $1 =~ ^[A-Z][A-Z0-9_]+-[0-9]+$ ]]
}

check_key() {
  if [[ ! $1 =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ || $1 == off ]]; then
    die "invalid key '$1': use letters, digits, '.', '_' and '-' ('off' is reserved)"
  fi
}

# Splits the brief on stdin into its Jira epic link and notes: sets $issue (''
# when unlinked) and $notes. The link lives in optional front matter: a first
# line "---", then blank or "jira: EPIC" lines, then a closing "---". Malformed
# front matter sets $problem and fails. parse() in brief.ts applies the same rules.
split_brief() {
  local -a lines
  local -i i
  issue='' notes='' problem=''
  mapfile -t lines
  if [[ ! ${lines[0]-} =~ ^[[:space:]]*---[[:space:]]*$ ]]; then
    printf -v notes '%s\n' "${lines[@]}"
    return 0
  fi
  for ((i = 1; i < ${#lines[@]}; i++)); do
    if [[ ${lines[i]} =~ ^[[:space:]]*---[[:space:]]*$ ]]; then
      printf -v notes '%s\n' "${lines[@]:i+1}"
      return 0
    elif [[ ${lines[i]} =~ ^[[:space:]]*jira:[[:space:]]*(.*[^[:space:]])?[[:space:]]*$ ]]; then
      issue=${BASH_REMATCH[1]}
      if [[ -n $issue ]] && ! is_jira "$issue"; then
        problem="'$issue' is not a Jira key"
        return 1
      fi
    elif [[ ${lines[i]} =~ ^[[:space:]]*(.*[^[:space:]]) ]]; then
      problem="unknown front matter line '${BASH_REMATCH[1]}'"
      return 1
    fi
  done
  problem='front matter has no closing ---'
  return 1
}

# Fails when FILE's front matter is malformed: omp refuses to load such a brief.
check_brief() {
  local key=${1##*/}
  key=${key%.md}
  split_brief <"$1" || die "$key is malformed: $problem (fix it with: brief edit $key)"
}

mtime() {
  stat -c %Y -- "$1" 2>/dev/null || echo 0
}

ago() {
  local -i seconds=$1
  if ((seconds < 60)); then
    printf 'just now'
  elif ((seconds < 3600)); then
    printf '%dm ago' $((seconds / 60))
  elif ((seconds < 86400)); then
    printf '%dh ago' $((seconds / 3600))
  else
    printf '%dd ago' $((seconds / 86400))
  fi
}

# First non-blank line of $notes that is not a Markdown heading.
summary() {
  local line
  while IFS= read -r line; do
    line=${line#"${line%%[![:space:]]*}"}
    line=${line%"${line##*[![:space:]]}"}
    if [[ -n $line && $line != '#'* ]]; then
      printf '%s' "${line:0:80}"
      return
    fi
  done <<<"$notes"
}

# Prints "LAST_USED<TAB>PATH<TAB>ROW" per brief in each DIR, most recently used first.
# LAST_USED is the later of the last omp load and the last edit; ROW is what users see.
listing() {
  local dir file key link when note
  local -i now width=0 linkwidth=1 used edited
  now=$(date +%s)
  for dir; do
    for file in "$dir"/*.md; do
      key=${file##*/}
      if ((${#key} - 3 > width)); then width=$((${#key} - 3)); fi
      if split_brief <"$file" && ((${#issue} > linkwidth)); then linkwidth=${#issue}; fi
    done
  done
  for dir; do
    for file in "$dir"/*.md; do
      key=${file##*/}
      key=${key%.md}
      if split_brief <"$file"; then
        link=${issue:--}
        note=$(summary)
      else
        link='?'
        note="malformed: $problem"
      fi
      used=$(mtime "$loaded/$key")
      edited=$(mtime "$file")
      when="never loaded"
      if ((used)); then when="loaded $(ago $((now - used)))"; fi
      if [[ $dir == "$archive" ]]; then note="[archived] $note"; fi
      printf '%d\t%s\t%-*s  %-*s  %-15s  %s\n' $((used > edited ? used : edited)) \
        "$file" "$width" "$key" "$linkwidth" "$link" "$when" "$note"
    done | sort -t $'\t' -k1,1nr
  done
}

# Lets the user choose one brief from DIRs with fzf and prints its path.
pick() {
  local verb=$1 list choice
  shift
  list=$(listing "$@" | cut -f2-)
  [[ -n $list ]] || die "no briefs to $verb"
  choice=$(fzf --prompt="$verb> " --delimiter='\t' --with-nth=2.. --preview='cat {1}' <<<"$list") || exit
  printf '%s\n' "${choice%%$'\t'*}"
}

# Path of an active brief: KEY, or a picked one when KEY is empty.
active_brief() {
  local key=$1 verb=$2
  if [[ -z $key ]]; then
    pick "$verb" "$active"
    return
  fi
  check_key "$key"
  if [[ -f $active/$key.md ]]; then
    printf '%s\n' "$active/$key.md"
  elif [[ -f $archive/$key.md ]]; then
    die "$key is archived; restore it with: brief restore $key"
  else
    die "no brief $key; create it with: brief new $key"
  fi
}

cmd_bind() {
  (($# <= 1)) || die "usage: brief bind [KEY]"
  git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a Git repository"
  local key file status
  if (($# == 0)); then
    if key=$(git config --local --get omp.brief); then
      printf '%s\n' "$key"
    else
      status=$?
      ((status == 1)) || exit "$status"
      printf 'No brief is bound to this repo.\n'
    fi
    return
  fi
  [[ -n $1 ]] || die "usage: brief bind [KEY]"
  file=$(active_brief "$1" bind)
  check_brief "$file"
  key=${file##*/}
  key=${key%.md}
  git config --local omp.brief "$key"
  printf 'Bound %s to this repo. New omp sessions will load it automatically.\n' "$key"
}

cmd_unbind() {
  (($# == 0)) || die "usage: brief unbind"
  git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a Git repository"
  local status
  if git config --local --unset-all omp.brief; then
    printf 'Removed the repo brief binding.\n'
  else
    status=$?
    ((status == 5)) || exit "$status"
    printf 'No brief is bound to this repo.\n'
  fi
}

edit_file() {
  local -a editor
  read -r -a editor <<<"${EDITOR:-vi}"
  "${editor[@]}" "$1"
}

archive_brief() {
  local key=${1##*/}
  key=${key%.md}
  [[ ! -e $archive/$key.md ]] || die "the archive already holds $key"
  mkdir -p "$archive"
  mv -- "$1" "$archive/$key.md"
  printf 'Archived %s.\n' "$key"
}

cmd_new() {
  local key='' link='' text='' template
  local given=false
  while (($#)); do
    case $1 in
      -j | --jira)
        (($# >= 2)) || die "$1 needs a Jira epic key"
        link=$2
        shift 2
        ;;
      -m | --message)
        (($# >= 2)) || die "$1 needs the notes text"
        text=$2 given=true
        shift 2
        ;;
      -*) die "unknown option $1 (usage: brief new KEY [-j EPIC] [-m TEXT])" ;;
      *)
        [[ -z $key ]] || die "usage: brief new KEY [-j EPIC] [-m TEXT]"
        key=$1
        shift
        ;;
    esac
  done
  [[ -n $key ]] || die "usage: brief new KEY [-j EPIC] [-m TEXT]"
  check_key "$key"
  if [[ -z $link ]] && is_jira "$key"; then link=$key; fi
  [[ -z $link ]] || is_jira "$link" || die "'$link' is not a Jira key (like CLOUD-4675)"
  [[ ! -e $active/$key.md ]] || die "$key already exists; edit it with: brief edit $key"
  [[ ! -e $archive/$key.md ]] || die "$key is archived; restore it with: brief restore $key"
  if ! $given && [[ ! -t 0 ]]; then
    text=$(cat)
    given=true
  fi

  if ! $given && [[ -z $link ]]; then
    tmp=$(mktemp --tmpdir --suffix=.md "brief-$key.XXXXXX")
    trap 'rm -f -- "$tmp"' EXIT
    template=$(printf '# %s\n\n## Goal\n\n\n## Why\n\n\n## Notes\n' "$key")
    printf '%s\n' "$template" >"$tmp"
    edit_file "$tmp"
    text=$(<"$tmp")
    [[ $text != "$template" ]] || die "template left unchanged; nothing created"
  fi

  [[ -n $link || $text == *[![:space:]]* ]] || die "empty brief; nothing created"
  mkdir -p "$active"
  {
    if [[ -n $link ]]; then printf -- '---\njira: %s\n---\n' "$link"; fi
    if [[ $text == *[![:space:]]* ]]; then printf '%s\n' "$text"; fi
  } >"$active/$key.md"
  # check_brief parses the file, so $issue is its link wherever the link came from.
  check_brief "$active/$key.md"
  printf 'Created %s%s. Load it in omp with /brief %s or omp --brief %s.\n' \
    "$key" "${issue:+, linked to $issue}" "$key" "$key"
}

cmd_edit() {
  (($# <= 1)) || die "usage: brief edit [KEY]"
  local file
  file=$(active_brief "${1-}" edit)
  edit_file "$file"
  check_brief "$file"
}

cmd_ls() {
  local list
  case $# in
    0) set -- "$active" ;;
    1)
      [[ $1 == -a || $1 == --all ]] || die "usage: brief ls [--all]"
      set -- "$active" "$archive"
      ;;
    *) die "usage: brief ls [--all]" ;;
  esac
  list=$(listing "$@" | cut -f3-)
  if [[ -n $list ]]; then
    printf '%s\n' "$list"
  else
    printf 'No briefs; create one with: brief new KEY\n' >&2
  fi
}

cmd_done() {
  (($# <= 1)) || die "usage: brief done [KEY]"
  local file
  file=$(active_brief "${1-}" archive)
  archive_brief "$file"
}

cmd_restore() {
  (($# <= 1)) || die "usage: brief restore [KEY]"
  local key=${1-} file
  if [[ -z $key ]]; then
    file=$(pick restore "$archive")
    key=${file##*/}
    key=${key%.md}
  else
    check_key "$key"
    file=$archive/$key.md
    if [[ ! -f $file ]]; then
      [[ ! -f $active/$key.md ]] || die "$key is already active"
      die "no archived brief $key"
    fi
  fi
  [[ ! -e $active/$key.md ]] || die "$key is already active"
  mkdir -p "$active"
  mv -- "$file" "$active/$key.md"
  # Restoring counts as use, so prune does not offer it straight back.
  touch -- "$active/$key.md"
  printf 'Restored %s.\n' "$key"
}

cmd_rm() {
  (($# <= 1)) || die "usage: brief rm [KEY]"
  local key=${1-} file reply
  if [[ -z $key ]]; then
    file=$(pick delete "$active" "$archive")
  else
    check_key "$key"
    file=$active/$key.md
    [[ -f $file ]] || file=$archive/$key.md
    [[ -f $file ]] || die "no brief $key"
  fi
  key=${file##*/}
  key=${key%.md}
  read -r -p "Delete brief $key permanently? [y/N] " reply || reply=
  [[ $reply == [yY]* ]] || die "kept $key"
  rm -f -- "$file" "$loaded/$key"
  printf 'Deleted %s.\n' "$key"
}

cmd_prune() {
  local days=14 list selection file used rest
  local -i cutoff
  while (($#)); do
    case $1 in
      --days)
        (($# >= 2)) || die "--days needs a number"
        days=$2
        shift 2
        ;;
      --days=*)
        days=${1#--days=}
        shift
        ;;
      *) die "usage: brief prune [--days N]" ;;
    esac
  done
  [[ $days =~ ^[0-9]+$ ]] || die "--days needs a whole number of days"
  cutoff=$(($(date +%s) - days * 86400))
  list=$(listing "$active" | sort -t $'\t' -k1,1n | while IFS=$'\t' read -r used rest; do
    if ((used < cutoff)); then printf '%s\n' "$rest"; fi
  done)
  if [[ -z $list ]]; then
    printf 'Nothing to prune: every active brief was loaded or edited in the last %s days.\n' "$days"
    return
  fi
  selection=$(fzf --multi --prompt='archive> ' --header='Tab selects, Enter archives the selection' \
    --delimiter='\t' --with-nth=2.. --preview='cat {1}' <<<"$list") || exit
  while IFS=$'\t' read -r file _; do
    archive_brief "$file"
  done <<<"$selection"
}

cmd=${1-}
if (($#)); then shift; fi
case $cmd in
  new) cmd_new "$@" ;;
  edit) cmd_edit "$@" ;;
  ls) cmd_ls "$@" ;;
  bind) cmd_bind "$@" ;;
  unbind) cmd_unbind "$@" ;;
  done) cmd_done "$@" ;;
  restore) cmd_restore "$@" ;;
  rm) cmd_rm "$@" ;;
  prune) cmd_prune "$@" ;;
  -h | --help | help) usage ;;
  '')
    usage >&2
    exit 2
    ;;
  *) die "unknown command '$cmd' (see brief --help)" ;;
esac
