{
  config,
  lib,
  pkgs,
  ...
}: let
  user = config.system.primaryUser;
  home = config.users.users.${user}.home;
  stateDir = "${home}/.local/state/tern-pilot";
  configDir = "${home}/Library/Application Support/Tern";
  tokenFile = "${stateDir}/web-token";
  daemonSocket = "${configDir}/daemon.sock";
  assetsRoot = "${home}/.local/share/tern-web";
  tailscale = "/run/current-system/sw/bin/tailscale";
  runtime = import ./tern/runtime {inherit pkgs;};
  ternSdk = pkgs.fetchFromGitHub {
    owner = "stencil-hq";
    repo = "tern-sdk";
    rev = "13d3cca8bbd8f055431f8eb3caa434a22e966f8f";
    hash = "sha256-9QW++GEcXzvr+csjAsUtr139KKH9jfeJ5ery7fKc4rc=";
  };
  ternKube = pkgs.fetchFromGitHub {
    owner = "contrafy";
    repo = "tern-kube";
    rev = "220aa65c78eeb6f3a92f55e67561da3c111410fd";
    hash = "sha256-hPwAUVqtIvqcgcGapoKzk0NRZya5/USEfZecK5v3kQI=";
  };
  labels = ["tern-pilot-daemon" "tern-pilot-web" "tern-pilot-gateway" "tern-pilot-tailnet" "tern-pilot-awake"];
  keyboardConfig = {
    keymap = "tmux";
    keymap_prefix = "ctrl+space";
    keybinds = {
      "ctrl+space>1" = "goto_tab:1";
      "ctrl+space>2" = "goto_tab:2";
      "ctrl+space>3" = "goto_tab:3";
      "ctrl+space>4" = "goto_tab:4";
      "ctrl+space>5" = "goto_tab:5";
      "ctrl+space>6" = "goto_tab:6";
      "ctrl+space>7" = "goto_tab:7";
      "ctrl+space>8" = "goto_tab:8";
      "ctrl+space>9" = "goto_tab:9";
      "ctrl+space>0" = "goto_tab:10";
      "ctrl+space>space" = "show_previous_tab";
      "ctrl+space>tab" = "plugin.session-navigation.next";
      "ctrl+space>shift+tab" = "plugin.session-navigation.previous";
      "ctrl+space>h" = "focus_pane:left";
      "ctrl+space>j" = "focus_pane:down";
      "ctrl+space>k" = "focus_pane:up";
      "ctrl+space>l" = "focus_pane:right";
      "ctrl+space>v" = "split_right";
      "ctrl+space>s" = "split_down";
      "ctrl+space>q" = "close_pane";
      "ctrl+space>ctrl+q" = "close_tab";
      "ctrl+space>i" = "inbox";
      "ctrl+space>g" = "new_git_block";
    };
  };
  keyboardSettings = pkgs.writeText "tern-keyboard-settings.json" (builtins.toJSON keyboardConfig);
  omp = import ../agents/omp/managed.nix {inherit lib;};
  # Declared state this command was built from. Checkout hashes let it say when
  # later edits are not in the build yet; nothing here is persisted at runtime.
  statusManifest = pkgs.writeText "tern-omp-status.json" (builtins.toJSON {
    checkout = "${home}/.config/home-manager";
    inherit home;
    sources =
      omp.inputs
      // builtins.listToAttrs (map (e: lib.nameValuePair e.source e.sha256) omp.extensions)
      // {"darwin/tern.nix" = builtins.hashFile "sha256" ./tern.nix;};
    omp = {inherit (omp) extensions mcpServers;};
    tern = {
      inherit (runtime) app;
      inherit assetsRoot labels configDir;
      socket = daemonSocket;
      settings = keyboardConfig;
    };
  });
  statusCommand = pkgs.writeShellScriptBin "tern-omp-status" ''
    if [ "$#" -ne 0 ]; then
      echo "Usage: tern-omp-status (read-only; takes no arguments)" >&2
      exit 2
    fi
    export TERN_STATUS_YQ=${pkgs.yq-go}/bin/yq
    exec ${pkgs.nodejs_24}/bin/node ${./tern/status.mjs} ${statusManifest}
  '';
  applySettings = pkgs.writeShellScriptBin "tern-settings-apply" ''
    set -euo pipefail
    umask 077
    directory="''${TERN_CONFIG_DIR:-$HOME/Library/Application Support/Tern}"
    target="$directory/settings.json"
    mkdir -p "$directory"
    plugin="$directory/plugins/session-navigation"
    if [ -e "$plugin" ] && [ ! -L "$plugin" ]; then
      echo "Tern session-navigation path is not a symlink; refusing replacement" >&2
      exit 1
    fi
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
    mkdir -p "$directory/plugins"
    ln -sfn ${./tern/session-navigation} "$plugin"
  '';
  preflight = pkgs.writeShellScript "tern-pilot-preflight" ''
    set -euo pipefail
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
    # Reject invalid settings/plugin paths before giving up the native daemon.
    ${applySettings}/bin/tern-settings-apply
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
    socket="${daemonSocket}"
    # An app-spawned daemon may own the socket; the real daemon would exit 0
    # at once and KeepAlive would respawn this job forever. Idle instead and
    # leave the secrets untouched until ownership frees. A stale socket file
    # without a listener has no owner, so it does not block startup.
    while /usr/sbin/lsof -t -- "$socket" >/dev/null 2>&1; do
      /bin/sleep 30
    done
    if [ -f "${home}/.config/home-manager/secrets.env" ]; then
      set -a
      if ! . "${home}/.config/home-manager/secrets.env" >/dev/null 2>&1; then
        echo "tern: failed to load secrets.env; refusing a partial omp environment" >&2
        exit 1
      fi
      set +a
    fi
    exec "${runtime.binary}" daemon --socket "$socket"
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
  # Browser assets are private and versioned by the installed app. Derive the
  # version at each service start and fail closed; never fall back to old assets.
  ternAssets = pkgs.writeShellScript "tern-pilot-assets" ''
    set -euo pipefail
    test -x "${runtime.binary}" || { echo "tern: ${runtime.app} is not installed" >&2; exit 1; }
    version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${runtime.app}/Contents/Info.plist") ||
      { echo "tern: cannot read the installed app version" >&2; exit 1; }
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] ||
      { echo "tern: unexpected installed app version" >&2; exit 1; }
    assets="${assetsRoot}/$version"
    if [ -L "$assets" ] || [ ! -f "$assets/index.html" ] || [ ! -f "$assets/pkg/stencil_tern_web_bg.wasm" ]; then
      echo "tern: browser assets for installed version $version missing from $assets" >&2
      exit 1
    fi
    printf '%s\n' "$assets"
  '';
  webCommand = pkgs.writeShellScript "tern-pilot-web" ''
    set -euo pipefail
    # Serve the browser client matching the installed app. Never listen with
    # missing assets or substitute a replacement client.
    assets=$(${ternAssets})
    identity=$(${tailnetIdentity})
    origin=$(printf '%s\n' "$identity" | ${pkgs.jq}/bin/jq -r .publicOrigin)
    exec "${runtime.binary}" web serve --listen 127.0.0.1:8377 \
      --token "${tokenFile}" --assets "$assets" \
      --allow-origin "http://127.0.0.1:8377" --allow-origin "$origin"
  '';
  gatewayCommand = pkgs.writeShellScript "tern-pilot-gateway" ''
    set -euo pipefail
    umask 077
    identity=$(${tailnetIdentity})
    export TERN_PUBLIC_ORIGIN="$(printf '%s\n' "$identity" | ${pkgs.jq}/bin/jq -r .publicOrigin)"
    export TERN_OWNER_LOGIN="$(printf '%s\n' "$identity" | ${pkgs.jq}/bin/jq -r .ownerLogin)"
    export TERN_TOKEN_FILE="${tokenFile}"
    assets=$(${ternAssets})
    export TERN_WASM_FILE="$assets/pkg/stencil_tern_web_bg.wasm"
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
    # Change only Tern's route; never enable Funnel.
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
    "/etc/profiles/per-user/${user}/bin"
    "/run/current-system/sw/bin"
    "/opt/homebrew/bin"
    "/usr/bin"
    "/bin"
    "/usr/sbin"
    "/sbin"
  ];
  plist = name:
    pkgs.writeText "org.nixos.${name}.plist"
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
    if ! "$web_only"; then
      ${lib.concatMapStringsSep "\n" (name: ''
        if launchctl print "gui/$(id -u)/org.nixos.${name}" >/dev/null 2>&1 \
          && ! cmp -s ${plist name} "${home}/Library/LaunchAgents/org.nixos.${name}.plist"; then
          echo "org.nixos.${name} is already loaded with different configuration; finish Tern turns before unloading it" >&2
          exit 1
        fi
      '')
      labels}
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
          if "$web_only" && ! cmp -s ${plist name} "$target"; then
            # Only disposable browser/route clients are replaced in this mode.
            launchctl bootout "$service"
            install -m 600 ${plist name} "$target"
            launchctl bootstrap "gui/$(id -u)" "$target"
          fi
        else
          install -m 600 ${plist name} "$target"
          launchctl bootstrap "gui/$(id -u)" "$target"
        fi
      '')
      labels}
    # Without -k this starts a stopped job but preserves an already running PID.
    /bin/launchctl kickstart "gui/$(id -u)/org.nixos.tern-pilot-daemon"
    target="${home}/.local/bin/tern"
    receipt="${stateDir}/cli-target"
    # Retired ownership record from the pinned runtime; it only authorizes
    # replacing the link it recorded.
    if [ -L "$receipt" ]; then
      echo "Refusing a symlinked CLI ownership record: $receipt" >&2
      exit 1
    fi
    if [ -L "$target" ]; then
      old_link=$(readlink "$target")
      if [ "$old_link" != "${runtime.binary}" ]; then
        if [ -f "$receipt" ] && [ "$(cat "$receipt")" = "$old_link" ]; then
          link_stage=$(mktemp -d "${stateDir}/.cli-link.XXXXXX")
          ln -s "${runtime.binary}" "$link_stage/tern"
          /bin/mv -fh "$link_stage/tern" "$target"
          rmdir "$link_stage"
        else
          echo "Existing $target left untouched; use ${runtime.tern}/bin/tern" >&2
        fi
      fi
    elif [ -e "$target" ]; then
      echo "Existing $target left untouched; use ${runtime.tern}/bin/tern" >&2
    else
      ln -s "${runtime.binary}" "$target"
    fi
    if [ -L "$target" ] && [ "$(readlink "$target")" = "${runtime.binary}" ]; then
      rm -f "$receipt"
    fi
    # Prefer the unversioned wrapper for the native app over any stale
    # `tern` earlier in the system profile, through the existing private hook.
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
      echo "Tern-only pilot activated; no Darwin switch."
    fi
  '';
in {
  home-manager.users.${user} = {
    home = {
      packages = [runtime.tern activate applySettings statusCommand];
      file = {
        "Library/Application Support/Tern/plugins/terraform".source = "${ternSdk}/plugins/examples/terraform";
        "Library/Application Support/Tern/plugins/jsonx".source = "${ternSdk}/plugins/examples/jsonx";
        "Library/Application Support/Tern/plugins/tern-kube".source = ternKube;
      };
    };
  };
  system.build.ternPilot = pkgs.symlinkJoin {
    name = "tern-pilot";
    paths = [runtime.tern activate applySettings statusCommand];
  };
  system.activationScripts.extraActivation.text = lib.mkAfter ''
    echo "preparing Tern integration for ${user}..." >&2
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
    # Keep phone access reachable through idle sleep, including on battery.
    # Display sleep and lid-close/forced sleep are unaffected.
    tern-pilot-awake = {
      command = "/usr/bin/caffeinate -i";
      serviceConfig = {
        KeepAlive = true;
        RunAtLoad = true;
        ProcessType = "Background";
        ThrottleInterval = 5;
        Umask = 63;
        StandardErrorPath = "${stateDir}/logs/awake.err";
      };
    };
  };
}
