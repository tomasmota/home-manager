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

  ocweb() {
    local host
    host="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"

    tailscale serve --http=4096 off >/dev/null 2>&1 || true
    echo "Open: http://$host:4096/"

    if command -v caffeinate >/dev/null 2>&1; then
      caffeinate -dimsu opencode web --port 4096 --hostname 0.0.0.0 "$@"
    else
      opencode web --port 4096 --hostname 0.0.0.0 "$@"
    fi
  }
''
