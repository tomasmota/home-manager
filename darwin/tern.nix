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
  assetsDir = "${home}/.local/share/tern-web/0.7.2";
  tailscale = "/run/current-system/sw/bin/tailscale";
  runtime = import ./tern/runtime {inherit pkgs home;};
  labels = ["tern-pilot-daemon" "tern-pilot-web" "tern-pilot-tailnet"];
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
    for log in daemon.out daemon.err web.out web.err tailnet.out tailnet.err; do
      touch "${stateDir}/logs/$log"
      chmod 600 "${stateDir}/logs/$log"
    done
    # The app registers its own service. One socket needs one launchd owner;
    # use the pilot's configured omp environment, not a second daemon loop.
    native_service="gui/$(id -u)/so.stencil.tern.daemon"
    /bin/launchctl disable "$native_service"
    if /bin/launchctl print "$native_service" >/dev/null 2>&1; then
      /bin/launchctl bootout "$native_service"
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
  webCommand = pkgs.writeShellScript "tern-pilot-web" ''
    set -euo pipefail
    # The arm64 DMG does not include the separately distributed WASM client.
    # Refuse to listen until the real client has been installed, never a fallback.
    if [ ! -f "${assetsDir}/index.html" ] || [ -L "${assetsDir}" ]; then
      echo "tern: browser assets missing from ${assetsDir}; web access not started" >&2
      exit 1
    fi
    dns=$(${tailscale} status --json | ${pkgs.nodejs_24}/bin/node -e '
      const fs = require("fs");
      const status = JSON.parse(fs.readFileSync(0, "utf8"));
      const name = (status.Self?.DNSName || "").replace(/\.$/, "");
      if (!name) process.exit(1);
      process.stdout.write(name);
    ')
    umask 077
    ${pkgs.nodejs_24}/bin/node -e '
      const fs = require("fs");
      const [file, tokenFile, dns] = process.argv.slice(1);
      const token = fs.readFileSync(tokenFile, "utf8").trim();
      fs.writeFileSync(file, JSON.stringify({url: `https://''${dns}:8377/?token=''${token}`}) + "\n", {mode: 0o600});
    ' "${stateDir}/phone-connection.json" "${tokenFile}" "$dns"
    exec "${runtime.binary}" web serve --listen 127.0.0.1:8377 \
      --token "${tokenFile}" --assets "${assetsDir}" \
      --allow-origin "http://127.0.0.1:8377" --allow-origin "https://$dns:8377"
  '';
  tailnetCommand = pkgs.writeShellScript "tern-pilot-tailnet" ''
    set -eu
    ${pkgs.curl}/bin/curl --fail --silent --output /dev/null http://127.0.0.1:8377/
    # A new port only: do not change Paseo's 6767 route, and never enable Funnel.
    exec ${tailscale} serve --bg --yes --https=8377 http://127.0.0.1:8377
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
  activate = pkgs.writeShellScriptBin "tern-pilot-activate" ''
    set -euo pipefail
    test "$(id -un)" = "${user}" || { echo "Run as ${user}, without sudo" >&2; exit 1; }
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
      if launchctl print "gui/$(id -u)/org.nixos.${name}" >/dev/null 2>&1; then
        cmp -s ${plist name} "$target" || {
          echo "org.nixos.${name} is already loaded with different configuration; finish Tern turns before unloading it" >&2
          exit 1
        }
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
    echo "Tern-only pilot activated; no Darwin switch or Paseo restart."
  '';
in {
  home-manager.users.tomas.home.packages = [runtime.tern activate];
  system.build.ternPilot = pkgs.symlinkJoin {
    name = "tern-pilot";
    paths = [runtime.tern activate];
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
