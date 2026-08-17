{config}: ''
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
    file=$(rg -S -l -- "$query" | fzf --preview "bat --color=always {}")
    if [[ -n "$file" ]]; then
      nvim "$file" -c "/$query"
    fi
  }

  nvf() {
    local query="''${1:-}"
    local file
    file=$(fd --type file "$query" | fzf --preview "bat --color=always {}")
    if [[ -n "$file" ]]; then
      nvim "$file"
    fi
  }

  nvfh() {
    local query="''${1:-}"
    local file
    file=$(fd --hidden --type file "$query" | fzf --preview "bat --color=always {}")
    if [[ -n "$file" ]]; then
      nvim "$file"
    fi
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

  # sync dotfiles
  hmsync() {
    pushd "${config.xdg.configHome}/home-manager" >/dev/null || return 1
    git pull
    hms
    popd >/dev/null || return 1
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
