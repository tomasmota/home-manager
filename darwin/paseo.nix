{
  lib,
  pkgs,
  ...
}: let
  user = "tomas";
  home = "/Users/tomas";
  stateDir = "${home}/.paseo";
  configFile = "${stateDir}/config.json";
  secretsFile = "${home}/.config/home-manager/secrets.env";
  tailscale = "/run/current-system/sw/bin/tailscale";
  runtime = import ./paseo/runtime {
    inherit pkgs home;
  };
  # Seeds only a missing config.json; pairing state and UI edits stay user-owned.
  preflight = pkgs.writeShellScript "paseo-activation-preflight" ''
    set -euo pipefail
    ${runtime.install}
    umask 077
    test ! -L "${stateDir}"
    mkdir -p "${stateDir}"
    chmod 700 "${stateDir}"
    if [ ! -e "${configFile}" ] && [ ! -L "${configFile}" ]; then
      (set -o noclobber; cat ${./paseo/config.json} >"${configFile}")
      echo "seeded ${configFile}" >&2
    fi
    test -f "${configFile}" && test ! -L "${configFile}"
    chmod 600 "${configFile}"
  '';
  # omp inherits this environment; source the same secrets as interactive zsh
  # without echoing them. A broken file is reported by name only.
  daemonCommand = pkgs.writeShellScript "paseo-daemon" ''
    set -eu
    if [ -f "${secretsFile}" ]; then
      set -a
      if ! . "${secretsFile}" >/dev/null 2>&1; then
        echo "paseo: failed to load secrets.env; refusing a partial omp environment" >&2
        exit 1
      fi
      set +a
    fi
    # Tailscale Serve forwards this Mac's MagicDNS name as Host; allow exactly
    # that name, read at start so no tailnet name lives in Git.
    if dns=$(${tailscale} status --json 2>/dev/null \
      | ${pkgs.nodejs_24}/bin/node -e 'try {const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const n=(s.Self&&s.Self.DNSName||"").replace(/\.$/,""); if(!n) process.exit(1); console.log(n)} catch {process.exit(1)}'); then
      export PASEO_HOSTNAMES="$dns"
    else
      echo "paseo: tailscale name unavailable; launchd will retry" >&2
      exit 1
    fi
    exec "${runtime.binary}" daemon run --home "${stateDir}"
  '';
in {
  # Runs after `checks` but before `userLaunchd`; under the activation script's
  # `set -e` a failed install aborts before the Paseo agents are (re)loaded.
  system.activationScripts.extraActivation.text = lib.mkAfter ''
    echo "installing locked paseo runtime for ${user}..." >&2
    launchctl asuser "$(id -u -- ${user})" sudo --user=${user} --set-home -- ${preflight}
  '';

  home-manager.users.tomas.home.packages = [runtime.paseo];

  launchd.user.agents.paseo = {
    path = [
      "${pkgs.nodejs_24}/bin"
      "/etc/profiles/per-user/tomas/bin"
      "/run/current-system/sw/bin"
      "/opt/homebrew/bin"
      "/usr/bin"
      "/bin"
      "/usr/sbin"
      "/sbin"
    ];
    environment = {
      HOME = home;
      # Env overrides config.json and locks these settings in the UI. Loopback
      # only; phones arrive through Tailscale Serve. The 0.10.3 relay admits
      # unauthenticated relay clients, so it stays off.
      PASEO_LISTEN = "127.0.0.1:6767";
      PASEO_RELAY_ENABLED = "false";
      XDG_CONFIG_HOME = "${home}/.config";
      XDG_DATA_HOME = "${home}/.local/share";
    };
    command = "${daemonCommand}";
    serviceConfig = {
      KeepAlive = true;
      RunAtLoad = true;
      # Not Background: omp sessions run under this job and must not be I/O throttled.
      ProcessType = "Standard";
      ThrottleInterval = 5;
      Umask = 63;
      WorkingDirectory = home;
      StandardOutPath = "${home}/Library/Logs/Paseo.log";
      StandardErrorPath = "${home}/Library/Logs/Paseo.error.log";
    };
  };

  # Tailnet-only HTTPS :6767 -> loopback :6767. Never Funnel.
  # tailscaled persists the route; re-apply it at login and retry until accepted.
  launchd.user.agents.paseo-tailnet = {
    command = "${tailscale} serve --bg --yes --https=6767 http://127.0.0.1:6767";
    serviceConfig = {
      RunAtLoad = true;
      KeepAlive.SuccessfulExit = false;
      ThrottleInterval = 60;
      Umask = 63;
      StandardOutPath = "${home}/Library/Logs/PaseoTailnet.log";
      StandardErrorPath = "${home}/Library/Logs/PaseoTailnet.error.log";
    };
  };

  # Holds a PreventUserIdleSystemSleep assertion (battery included). It does not
  # keep the display on and cannot prevent lid-close or forced sleep.
  launchd.user.agents.paseo-awake = {
    command = "/usr/bin/caffeinate -i";
    serviceConfig = {
      KeepAlive = true;
      RunAtLoad = true;
      ProcessType = "Background";
      ThrottleInterval = 5;
      Umask = 63;
      StandardErrorPath = "${home}/Library/Logs/PaseoAwake.error.log";
    };
  };
}
