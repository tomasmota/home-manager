{
  config,
  lib,
  pkgs,
  ...
}: let
  user = "tomas";
  home = "/Users/tomas";
  stateDir = "${home}/.local/state/tern-pilot";
  configDir = "${home}/Library/Application Support/Tern";
  tokenFile = "${stateDir}/web-token";
  assetsDir = "${home}/.local/share/tern-web/${runtime.version}";
  tailscale = "/run/current-system/sw/bin/tailscale";
  runtime = import ./tern/runtime {inherit pkgs home;};
  labels = ["tern-pilot-daemon" "tern-pilot-web" "tern-pilot-gateway" "tern-pilot-tailnet"];
  keyboardSettings = pkgs.writeText "tern-keyboard-settings.json" (builtins.toJSON {
    keymap = "tmux";
    keymap_prefix = "ctrl+space";
    keybinds = {
      "ctrl+space>h" = "focus_pane:left";
      "ctrl+space>j" = "focus_pane:down";
      "ctrl+space>k" = "focus_pane:up";
      "ctrl+space>l" = "focus_pane:right";
      "ctrl+space>v" = "split_right";
      "ctrl+space>s" = "split_down";
      "ctrl+space>q" = "close_pane";
      "ctrl+space>ctrl+q" = "close_tab";
    };
  });
  applySettings = pkgs.writeShellScriptBin "tern-settings-apply" ''
    set -euo pipefail
    umask 077
    directory="''${TERN_CONFIG_DIR:-$HOME/Library/Application Support/Tern}"
    target="$directory/settings.json"
    mkdir -p "$directory"
    tmp=$(mktemp "$directory/.settings.json.XXXXXX")
    trap 'rm -f "$tmp"' EXIT
    if [ -e "$target" ]; then
      ${pkgs.jq}/bin/jq -e -s '
        if all(.[]; type == "object") then .[0] * .[1]
        else error("Tern settings must be JSON objects") end
      ' "$target" ${keyboardSettings} > "$tmp"
    else
      cp ${keyboardSettings} "$tmp"
    fi
    chmod 600 "$tmp"
    mv -f "$tmp" "$target"
  '';
  preflight = pkgs.writeShellScript "tern-pilot-preflight" ''
    set -euo pipefail
    ${runtime.install}
    umask 077
    for directory in "${stateDir}" "${configDir}" "${stateDir}/logs"; do
      test ! -L "$directory"
      mkdir -p "$directory"
      chmod 700 "$directory"
    done
    if [ ! -e "${tokenFile}" ] && [ ! -L "${tokenFile}" ]; then
      ${pkgs.openssl}/bin/openssl rand -hex -out "${tokenFile}" 32
    fi
    test -f "${tokenFile}" && test ! -L "${tokenFile}"
    token=$(cat "${tokenFile}")
    [[ "$token" =~ ^[0-9a-f]{64}$ ]]
    chmod 600 "${tokenFile}"
    for log in daemon.out daemon.err web.out web.err gateway.out gateway.err tailnet.out tailnet.err; do
      touch "${stateDir}/logs/$log"
      chmod 600 "${stateDir}/logs/$log"
    done
    # Full activation establishes one socket owner. A browser-only upgrade
    # must not disable or unload either daemon service.
    if [ "''${1:-}" != "--web-only" ]; then
      native_service="gui/$(id -u)/so.stencil.tern.daemon"
      /bin/launchctl disable "$native_service"
      if /bin/launchctl print "$native_service" >/dev/null 2>&1; then
        /bin/launchctl bootout "$native_service"
      fi
    fi
  '';
  daemonCommand = pkgs.writeShellScript "tern-pilot-daemon" ''
    set -eu
    if [ -f "${home}/.config/home-manager/secrets.env" ]; then
      set -a
      if ! . "${home}/.config/home-manager/secrets.env" >/dev/null 2>&1; then
        echo "tern: failed to load secrets.env; refusing a partial omp environment" >&2
        exit 1
      fi
      set +a
    fi
    exec "${runtime.binary}" daemon
  '';
  tailnetIdentity = pkgs.writeShellScript "tern-pilot-tailnet-identity" ''
    set -euo pipefail
    ${tailscale} status --json | ${pkgs.jq}/bin/jq -ce '
      .Self as $self |
      (.User[($self.UserID | tostring)].LoginName // "") as $owner |
      (($self.DNSName // "") | rtrimstr(".")) as $dns |
      if $dns == "" or ($owner | test("^[!-~]+$") | not)
          or (($self.Tags // []) | length) != 0 then
        error("Tern gateway requires a user-owned Tailscale identity")
      else
        {publicOrigin: ("https://" + $dns + ":8377"), ownerLogin: $owner}
      end
    '
  '';
  webCommand = pkgs.writeShellScript "tern-pilot-web" ''
    set -euo pipefail
    # Cache the genuine release client and its integrity-pinned WASM locally.
    # Never listen with missing assets or substitute a replacement client.
    if [ ! -f "${assetsDir}/index.html" ] || [ -L "${assetsDir}" ]; then
      echo "tern: browser assets missing from ${assetsDir}; web access not started" >&2
      exit 1
    fi
    identity=$(${tailnetIdentity})
    origin=$(printf '%s\n' "$identity" | ${pkgs.jq}/bin/jq -r .publicOrigin)
    exec "${runtime.binary}" web serve --listen 127.0.0.1:8377 \
      --token "${tokenFile}" --assets "${assetsDir}" \
      --allow-origin "http://127.0.0.1:8377" --allow-origin "$origin"
  '';
  gatewayCommand = pkgs.writeShellScript "tern-pilot-gateway" ''
    set -euo pipefail
    umask 077
    identity=$(${tailnetIdentity})
    export TERN_PUBLIC_ORIGIN="$(printf '%s\n' "$identity" | ${pkgs.jq}/bin/jq -r .publicOrigin)"
    export TERN_OWNER_LOGIN="$(printf '%s\n' "$identity" | ${pkgs.jq}/bin/jq -r .ownerLogin)"
    export TERN_TOKEN_FILE="${tokenFile}"
    export TERN_WASM_FILE="${assetsDir}/pkg/stencil_tern_web_bg.wasm"
    ${pkgs.nodejs_24}/bin/node -e '
      const fs = require("fs");
      const [file, origin] = process.argv.slice(1);
      fs.writeFileSync(file, JSON.stringify({url: origin + "/"}) + "\n", {mode: 0o600});
    ' "${stateDir}/phone-connection.json" "$TERN_PUBLIC_ORIGIN"
    exec ${pkgs.nodejs_24}/bin/node ${./tern/gateway.mjs}
  '';
  tailnetCommand = pkgs.writeShellScript "tern-pilot-tailnet" ''
    set -eu
    identity=$(${tailnetIdentity})
    owner=$(printf '%s\n' "$identity" | ${pkgs.jq}/bin/jq -r .ownerLogin)
    ${pkgs.curl}/bin/curl --fail --silent --output /dev/null \
      --header "Tailscale-User-Login: $owner" http://127.0.0.1:18377/
    # A new port only: do not change Paseo's 6767 route, and never enable Funnel.
    exec ${tailscale} serve --bg --yes --https=8377 http://127.0.0.1:18377
  '';
  environment = {
    HOME = home;
    SHELL = "${pkgs.zsh}/bin/zsh";
    TERN_CONFIG_DIR = configDir;
    STENCIL_LOG_DIR = "${stateDir}/logs";
    XDG_CONFIG_HOME = "${home}/.config";
    XDG_DATA_HOME = "${home}/.local/share";
  };
  path = [
    "${pkgs.zsh}/bin"
    "/etc/profiles/per-user/tomas/bin"
    "/run/current-system/sw/bin"
    "/opt/homebrew/bin"
    "/usr/bin"
    "/bin"
    "/usr/sbin"
    "/sbin"
  ];
  plist = name: pkgs.writeText "org.nixos.${name}.plist"
    config.environment.userLaunchAgents."org.nixos.${name}.plist".text;
  cliEnvironment = pkgs.writeText "tern-pilot-cli-env.zsh" ''
    case "$PATH" in
      "${runtime.tern}/bin"|"${runtime.tern}/bin":*) ;;
      *) export PATH="${runtime.tern}/bin:$PATH" ;;
    esac
  '';
  activate = pkgs.writeShellScriptBin "tern-pilot-activate" ''
    set -euo pipefail
    web_only=false
    if [ "$#" -eq 1 ] && [ "$1" = "--web-only" ]; then
      web_only=true
    elif [ "$#" -ne 0 ]; then
      echo "Usage: tern-pilot-activate [--web-only]" >&2
      exit 2
    fi
    test "$(id -un)" = "${user}" || { echo "Run as ${user}, without sudo" >&2; exit 1; }
    if "$web_only" && ! launchctl print "gui/$(id -u)/org.nixos.tern-pilot-daemon" >/dev/null 2>&1; then
      echo "Web-only activation requires the managed daemon; activate the full pilot first" >&2
      exit 1
    fi
    umask 077
    test ! -L "${stateDir}"
    mkdir -p "${stateDir}/gcroots"
    chmod 700 "${stateDir}" "${stateDir}/gcroots"
    activationStore=$(dirname "$(dirname "$(${pkgs.coreutils}/bin/realpath "$0")")")
    # No system generation owns a Tern-only activation. Root this script and
    # its referenced plists/wrappers before launchd can outlive the build.
    ${config.nix.package}/bin/nix-store --realise "$activationStore" \
      --add-root "${stateDir}/gcroots/$(basename "$activationStore")" --indirect >/dev/null
    if "$web_only"; then
      ${preflight} --web-only
    else
      ${preflight}
    fi
    ${applySettings}/bin/tern-settings-apply
    mkdir -p "${home}/Library/LaunchAgents" "${home}/.local/bin"
    ${lib.concatMapStringsSep "\n" (name: ''
      target="${home}/Library/LaunchAgents/org.nixos.${name}.plist"
      service="gui/$(id -u)/org.nixos.${name}"
      if "$web_only" && [ "${name}" = "tern-pilot-daemon" ]; then
        # A browser upgrade must not stop the user's pane-owning daemon.
        launchctl print "$service" >/dev/null 2>&1 || {
          echo "Web-only activation requires the managed daemon; activate the full pilot first" >&2
          exit 1
        }
      elif launchctl print "$service" >/dev/null 2>&1; then
        if ! cmp -s ${plist name} "$target"; then
          if ! "$web_only"; then
            echo "org.nixos.${name} is already loaded with different configuration; finish Tern turns before unloading it" >&2
            exit 1
          fi
          # Only disposable browser/route clients are replaced in this mode.
          launchctl bootout "$service"
          install -m 600 ${plist name} "$target"
          launchctl bootstrap "gui/$(id -u)" "$target"
        fi
      else
        install -m 600 ${plist name} "$target"
        launchctl bootstrap "gui/$(id -u)" "$target"
      fi
    '') labels}
    # Without -k this starts a stopped job but preserves an already running PID.
    /bin/launchctl kickstart "gui/$(id -u)/org.nixos.tern-pilot-daemon"
    target="${home}/.local/bin/tern"
    receipt="${stateDir}/cli-target"
    if [ -L "$receipt" ]; then
      echo "Refusing a symlinked CLI ownership record: $receipt" >&2
      exit 1
    fi
    if [ -L "$target" ]; then
      old_link=$(readlink "$target")
      # Preserve the current native link; migrate only links owned by this pilot.
      case "$old_link" in
        "${runtime.tern}/bin/tern"|"${runtime.binary}") ;;
        *)
          owned=false
          if [ -f "$receipt" ] && [ "$(cat "$receipt")" = "$old_link" ]; then
            owned=true
          fi
          prefix="${home}/.local/share/tern-runtime/"
          case "$old_link" in
            "$prefix"*/Tern.app/Contents/MacOS/tern)
              old_release=''${old_link#"$prefix"}
              old_release=''${old_release%"/Tern.app/Contents/MacOS/tern"}
              if [[ "$old_release" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{64}(-[0-9a-f]{64})?$ ]]; then
                owned=true
              fi
              ;;
          esac
          if ! "$owned"; then
            echo "Existing $target left untouched; use ${runtime.tern}/bin/tern" >&2
            exit 1
          fi
          link_stage=$(mktemp -d "${stateDir}/.cli-link.XXXXXX")
          ln -s "${runtime.tern}/bin/tern" "$link_stage/tern"
          /bin/mv -fh "$link_stage/tern" "$target"
          rmdir "$link_stage"
          ;;
      esac
    elif [ -e "$target" ]; then
      echo "Existing $target left untouched; use ${runtime.tern}/bin/tern" >&2
      exit 1
    else
      ln -s "${runtime.tern}/bin/tern" "$target"
    fi
    printf '%s\n' "$(readlink "$target")" > "$receipt"
    chmod 600 "$receipt"
    # The system profile can still contain the preceding pilot release.
    # Use the existing private shell hook to prefer only this Tern package.
    hook="${home}/.config/home-manager/shell/local.zsh"
    test ! -L "$hook"
    if [ -e "$hook" ] && [ ! -f "$hook" ]; then
      echo "Refusing a non-file shell hook: $hook" >&2
      exit 1
    fi
    install -m 600 ${cliEnvironment} "${stateDir}/cli-env.zsh"
    hook_line='[ ! -r "$HOME/.local/state/tern-pilot/cli-env.zsh" ] || . "$HOME/.local/state/tern-pilot/cli-env.zsh"'
    if ! ${pkgs.gnugrep}/bin/grep -qxF "$hook_line" "$hook" 2>/dev/null; then
      printf '\n%s\n' "$hook_line" >> "$hook"
    fi
    if "$web_only"; then
      echo "Tern web pilot activated; existing daemon and pane programs preserved."
    else
      echo "Tern-only pilot activated; no Darwin switch or Paseo restart."
    fi
  '';
in {
  home-manager.users.tomas = {lib, ...}: {
    home.packages = [runtime.tern activate applySettings];
    # Keep settings writable for Tern's UI; only managed keyboard keys win.
    home.activation.ternSettings = lib.hm.dag.entryAfter ["writeBoundary"] ''
      run ${applySettings}/bin/tern-settings-apply
    '';
  };
  system.build.ternPilot = pkgs.symlinkJoin {
    name = "tern-pilot";
    paths = [runtime.tern activate applySettings];
  };
  system.activationScripts.extraActivation.text = lib.mkAfter ''
    echo "installing pinned Tern pilot for ${user}..." >&2
    launchctl asuser "$(id -u -- ${user})" sudo --user=${user} --set-home -- ${preflight}
  '';
  launchd.user.agents = {
    tern-pilot-daemon = {
      inherit environment path;
      command = "${daemonCommand}";
      serviceConfig = {
        RunAtLoad = true;
        KeepAlive = true;
        ProcessType = "Interactive";
        # Match Tern's bundled service: daemon upgrades must not kill pane PTYs.
        AbandonProcessGroup = true;
        ThrottleInterval = 5;
        Umask = 63;
        WorkingDirectory = home;
        StandardOutPath = "${stateDir}/logs/daemon.out";
        StandardErrorPath = "${stateDir}/logs/daemon.err";
      };
    };
    tern-pilot-web = {
      inherit environment path;
      command = "${webCommand}";
      serviceConfig = {
        RunAtLoad = true;
        KeepAlive = true;
        ProcessType = "Standard";
        ThrottleInterval = 60;
        Umask = 63;
        WorkingDirectory = home;
        StandardOutPath = "${stateDir}/logs/web.out";
        StandardErrorPath = "${stateDir}/logs/web.err";
      };
    };
    tern-pilot-gateway = {
      inherit environment path;
      command = "${gatewayCommand}";
      serviceConfig = {
        RunAtLoad = true;
        KeepAlive = true;
        ProcessType = "Standard";
        ThrottleInterval = 60;
        Umask = 63;
        WorkingDirectory = home;
        StandardOutPath = "${stateDir}/logs/gateway.out";
        StandardErrorPath = "${stateDir}/logs/gateway.err";
      };
    };
    tern-pilot-tailnet = {
      command = "${tailnetCommand}";
      serviceConfig = {
        RunAtLoad = true;
        KeepAlive.SuccessfulExit = false;
        ThrottleInterval = 60;
        Umask = 63;
        StandardOutPath = "${stateDir}/logs/tailnet.out";
        StandardErrorPath = "${stateDir}/logs/tailnet.err";
      };
    };
  };
}
