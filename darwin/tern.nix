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
  daemonSocket = "${configDir}/daemon.sock";
  runtime = import ./tern/runtime {inherit pkgs;};
  ternSdk = pkgs.fetchFromGitHub {
    owner = "stencil-hq";
    repo = "tern-sdk";
    rev = "13d3cca8bbd8f055431f8eb3caa434a22e966f8f";
    hash = "sha256-9QW++GEcXzvr+csjAsUtr139KKH9jfeJ5ery7fKc4rc=";
  };
  ternKube = pkgs.applyPatches {
    name = "tern-kube";
    src = pkgs.fetchFromGitHub {
      owner = "contrafy";
      repo = "tern-kube";
      rev = "220aa65c78eeb6f3a92f55e67561da3c111410fd";
      hash = "sha256-hPwAUVqtIvqcgcGapoKzk0NRZya5/USEfZecK5v3kQI=";
    };
    patches = [./tern/tern-kube-window-load.patch];
  };
  ternSchedules = pkgs.fetchFromGitHub {
    owner = "bmanturner";
    repo = "tern-agent-scheduler";
    rev = "539796596798047a889aefbbca871a38d50588f0";
    hash = "sha256-bDV1rYULsMTh1joxQKkParIRcwMUcnSBU4L5+H5X5Jo=";
  };
  labels = ["tern-pilot-daemon"];
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
      "ctrl+space>tab" = "plugin.session-navigation.last";
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
      // {
        "darwin/tern.nix" = builtins.hashFile "sha256" ./tern.nix;
        "darwin/tern/tern-kube-window-load.patch" = builtins.hashFile "sha256" ./tern/tern-kube-window-load.patch;
      };
    omp = {inherit (omp) extensions mcpServers;};
    tern = {
      inherit (runtime) app;
      inherit labels configDir;
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
    for log in daemon.out daemon.err; do
      touch "${stateDir}/logs/$log"
      chmod 600 "${stateDir}/logs/$log"
    done
    # Reject invalid settings/plugin paths before giving up the native daemon.
    ${applySettings}/bin/tern-settings-apply
    # Establish one socket owner under the managed daemon service.
    native_service="gui/$(id -u)/so.stencil.tern.daemon"
    /bin/launchctl disable "$native_service"
    if /bin/launchctl print "$native_service" >/dev/null 2>&1; then
      /bin/launchctl bootout "$native_service"
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
    if [ "$#" -ne 0 ]; then
      echo "Usage: tern-pilot-activate" >&2
      exit 2
    fi
    test "$(id -un)" = "${user}" || { echo "Run as ${user}, without sudo" >&2; exit 1; }
    ${lib.concatMapStringsSep "\n" (name: ''
        if launchctl print "gui/$(id -u)/org.nixos.${name}" >/dev/null 2>&1 \
          && ! cmp -s ${plist name} "${home}/Library/LaunchAgents/org.nixos.${name}.plist"; then
          echo "org.nixos.${name} is already loaded with different configuration; finish Tern turns before unloading it" >&2
          exit 1
        fi
      '')
      labels}
    umask 077
    test ! -L "${stateDir}"
    mkdir -p "${stateDir}/gcroots"
    chmod 700 "${stateDir}" "${stateDir}/gcroots"
    activationStore=$(dirname "$(dirname "$(${pkgs.coreutils}/bin/realpath "$0")")")
    # No system generation owns a Tern-only activation. Root this script and
    # its referenced plists/wrappers before launchd can outlive the build.
    ${config.nix.package}/bin/nix-store --realise "$activationStore" \
      --add-root "${stateDir}/gcroots/$(basename "$activationStore")" --indirect >/dev/null
    ${preflight}
    mkdir -p "${home}/Library/LaunchAgents" "${home}/.local/bin"
    ${lib.concatMapStringsSep "\n" (name: ''
        target="${home}/Library/LaunchAgents/org.nixos.${name}.plist"
        service="gui/$(id -u)/org.nixos.${name}"
        if ! launchctl print "$service" >/dev/null 2>&1; then
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
    echo "Tern-only pilot activated; no Darwin switch."
  '';
in {
  home-manager.users.${user} = {
    home = {
      packages = [runtime.tern activate applySettings statusCommand];
      file = {
        "Library/Application Support/Tern/plugins/terraform".source = "${ternSdk}/plugins/examples/terraform";
        "Library/Application Support/Tern/plugins/jsonx".source = "${ternSdk}/plugins/examples/jsonx";
        "Library/Application Support/Tern/plugins/tern-kube".source = ternKube;
        "Library/Application Support/Tern/plugins/tern-agent-scheduler".source = ternSchedules;
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
  };
}
