{
  config,
  pkgs,
}: let
  sudoTerminalAskpass = pkgs.writeShellScript "sudo-terminal-askpass" ''
    IFS= read -r -s -p '[sudo] Password: ' password </dev/tty || exit 1
    printf '\n' >/dev/tty
    printf '%s\n' "$password"
  '';
in ''
  # delete a tag from local and origin
  delete_tag() {
    if [ -z "$1" ]; then
      echo "Usage: delete_tag <tag>"
      return 1
    fi

    git tag -d "$1"
    git push --delete origin "$1"
  }

  # open files based on ripgrep search
  nvg() {
    local query="$1"
    if [ -z "$query" ]; then
      echo "Usage: nvg <pattern>"
      return 1
    fi

    local file
    file=$(rg -S -l --null -- "$query" | fzf --read0 --print0 --preview "bat --color=always -- {}") || return
    file=''${file%$'\0'}
    [[ -n "$file" ]] || return 1
    nvim -c "/$query" -- "$file"
  }

  nvf() {
    local query="''${1:-}"
    local file
    file=$(fd --type file --print0 -- "$query" | fzf --read0 --print0 --preview "bat --color=always -- {}") || return
    file=''${file%$'\0'}
    [[ -n "$file" ]] || return 1
    nvim -- "$file"
  }

  nvfh() {
    local query="''${1:-}"
    local file
    file=$(fd --hidden --type file --print0 -- "$query" | fzf --read0 --print0 --preview "bat --color=always -- {}") || return
    file=''${file%$'\0'}
    [[ -n "$file" ]] || return 1
    nvim -- "$file"
  }

  cdf() {
    local dir
    dir=$(fd --type directory --print0 \
      | fzf --read0 --print0 --preview 'tree -I "node_modules|dist|coverage" -C -- {}') || return
    dir=''${dir%$'\0'}
    [[ -n "$dir" ]] || return 1
    cd -- "$dir"
  }

  cdr() {
    local dir
    dir=$(fd --search-path "$HOME/dev" -d 7 -t d --hidden --no-ignore-vcs \
      --format '{//}' --print0 '^\.git$' \
      | fzf --read0 --print0 --preview 'tree -I "node_modules|dist|coverage" -C -- {}') || return
    dir=''${dir%$'\0'}
    [[ -n "$dir" ]] || return 1
    cd -- "$dir"
  }

  nvd() {
    local dir
    dir=$(fd --type directory --print0 \
      | fzf --read0 --print0 --preview 'tree -I "node_modules|dist|coverage" -C -- {}') || return
    dir=''${dir%$'\0'}
    [[ -n "$dir" ]] || return 1
    nvim -- "$dir"
  }

  # fuzzy pick a tofu root (directory with a .terraform.lock.hcl) in the current repo into $REPLY;
  # --init also prints it and runs tofu init there unless it already has a .terraform directory
  _tofu_root() {
    local repo dir
    # Keep trailing newlines in repository names through command substitution.
    repo=$(git rev-parse --show-toplevel && printf '\0') || return
    repo=''${repo%$'\n\0'}
    dir=$(cd -q -- "$repo" && fd --type f --hidden --glob \
      --format '{//}' --print0 ".terraform.lock.hcl" \
      | fzf --read0 --print0 --preview 'tree -I "node_modules|.terraform|.git|dist|coverage" -C -- {}') || return
    dir=''${dir%$'\0'}
    [[ -n "$dir" ]] || return 1
    REPLY=$repo/$dir
    [[ $1 == --init ]] || return 0
    print -r -- "''${(D)REPLY}"
    [[ -d $REPLY/.terraform ]] || tofu -chdir="$REPLY" init
  }

  # show remaining weekly quota for z.ai and chatgpt plus
  quotas() {
    {
      printf 'PROVIDER\tREMAINING\tRESETS\n'

      curl -s 'https://api.z.ai/api/monitor/usage/quota/limit' -H "Authorization: $ZAI_API_KEY" |
        jq -r '.data.limits | max_by(.nextResetTime) |
          (.nextResetTime / 1000) as $t |
          ($t - now) as $d |
          [ "z.ai",
            ((100 * .remaining / .usage) | round | tostring) + "%",
            ($t | localtime | strftime("%a, %b %d at %H:%M")) +
              " (in " +
              (if $d < 3600 then "\($d / 60 | round)m"
               elif $d < 86400 then "\($d / 3600 | round)h"
               else "\($d / 86400 | round)d" end) + ")" ] | @tsv'

      (
        printf '%s\n' \
          '{"method":"initialize","id":0,"params":{"clientInfo":{"name":"quota-check","title":"Quota Check","version":"1.0.0"}}}' \
          '{"method":"initialized","params":{}}' \
          '{"method":"account/rateLimits/read","id":1}'
        sleep 2
      ) | codex app-server 2>/dev/null |
        jq -r 'select(.id == 1) | .result.rateLimitsByLimitId |
          [ .[] | [.primary, .secondary][] | select(. != null) | select(.windowDurationMins == 10080) ][0] |
          .resetsAt as $t |
          ($t - now) as $d |
          [ "chatgpt",
            (100 - .usedPercent | tostring) + "%",
            ($t | localtime | strftime("%a, %b %d at %H:%M")) +
              " (in " +
              (if $d < 3600 then "\($d / 60 | round)m"
               elif $d < 86400 then "\($d / 3600 | round)h"
               else "\($d / 86400 | round)d" end) + ")" ] | @tsv'
    } | column -t -s $'\t'
  }

  # home-manager switch
  hms() {
    if [[ "$(uname)" == "Darwin" ]]; then
      echo "Use nds on macOS (hms is linux-only)."
      return 1
    fi

    if [ $# -eq 0 ]; then
      home-manager switch --flake .#linux
    else
      home-manager switch --flake ".#$1"
    fi
  }

  # nix-darwin switch
  nds() {
    sudo darwin-rebuild switch --flake "${config.xdg.configHome}/home-manager#macbook" "$@"
  }

  # nix-darwin switch with a hidden terminal password instead of Touch ID
  ndsh() {
    SUDO_ASKPASS="${sudoTerminalAskpass}" /usr/bin/sudo -A \
      darwin-rebuild switch --flake "${config.xdg.configHome}/home-manager#macbook" "$@"
  }

  # Apply the checkout in the cwd: hms on Linux; on macOS the switch needs sudo,
  # so only print the choice instead of invoking it.
  _hm_apply() {
    if [[ "$(uname)" == "Darwin" ]]; then
      echo "Not applied. Run nds (Touch ID) or ndsh (terminal password) to switch."
      return 0
    fi
    hms
  }

  # edit dotfiles, then apply; nothing is applied if the editor fails
  hme() {
    local rc
    pushd "${config.xdg.configHome}/home-manager" >/dev/null || return 1
    nvim . && _hm_apply
    rc=$?
    popd >/dev/null
    return $rc
  }

  # sync dotfiles, then apply; nothing is applied if the pull fails
  hmsync() {
    local rc
    pushd "${config.xdg.configHome}/home-manager" >/dev/null || return 1
    git pull && _hm_apply
    rc=$?
    popd >/dev/null
    return $rc
  }

  gacp() {
    if [ -z "$1" ]; then
      echo "Error: Please provide a commit message"
      echo "Usage: gacp \"commit message\""
      return 1
    fi

    git add --all
    git commit -m "$1"
    git push
  }

  gpmr() {
    local output_file push_status url
    output_file=$(mktemp) || return

    git push -o merge_request.create "$@" 2>&1 | tee "$output_file"
    push_status=$pipestatus[1]
    if ((push_status != 0)); then
      rm -f "$output_file"
      return "$push_status"
    fi

    url=$(rg --only-matching 'https://[^[:space:]]+/-/merge_requests/[0-9]+' "$output_file" | tail -n 1)
    rm -f "$output_file"
    if [[ -z "$url" ]]; then
      echo "Merge request pushed, but its URL was not present in the output."
      return 0
    fi

    if command -v pbcopy >/dev/null; then
      print -rn -- "$url" | pbcopy
      echo "Copied merge request URL: $url"
    else
      echo "Merge request URL: $url"
    fi
  }
''
