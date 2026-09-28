{pkgs, ...}: let
  version = "7.3.19";
  archiveSha256 = "sha256-VY9yzCubFZOuVuhVv6He2euAzXNOldlZa61TEPtb7O8=";
  binarySha256 = "2af8429560a91add289d9197b8f769a4325ceb4f8fc43ba0f76cf793eb469504";
  configDir = "/Users/tomas/.config/cliproxyapi";
  configFile = "${configDir}/config.yaml";
  envFile = "${configDir}/client.env";
  authDir = "/Users/tomas/.local/share/cliproxyapi/auth";
  cliProxyApi = pkgs.stdenvNoCC.mkDerivation {
    pname = "cli-proxy-api";
    inherit version;
    src = pkgs.fetchurl {
      url = "https://github.com/router-for-me/CLIProxyAPI/releases/download/v${version}/CLIProxyAPI_${version}_darwin_aarch64.tar.gz";
      hash = archiveSha256;
    };
    dontUnpack = true;
    nativeBuildInputs = [pkgs.coreutils pkgs.gnutar];
    installPhase = ''
      tar -xzf "$src" cli-proxy-api
      install -Dm755 cli-proxy-api "$out/bin/cli-proxy-api"
      test "$(sha256sum "$out/bin/cli-proxy-api" | cut -d ' ' -f 1)" = "${binarySha256}"
    '';
  };
  openchamberCommand = pkgs.writeShellScript "openchamber" ''
    set -eu
    set -a
    . "${envFile}"
    set +a
    exec ${pkgs.nodejs_24}/bin/node \
      /Users/tomas/.npm-global/lib/node_modules/@openchamber/web/bin/cli.js \
      serve --foreground --host 127.0.0.1 --port 3001
  '';
in {
  environment.systemPackages = [cliProxyApi];

  home-manager.users.tomas = {lib, ...}: {
    home.activation.cliProxyApi = lib.hm.dag.entryAfter ["writeBoundary"] ''
      if [ -z "$DRY_RUN_CMD" ]; then
        umask 077
        install -d -m 700 "${configDir}" "${authDir}"
        if [ ! -f "${envFile}" ]; then
          key=$(${pkgs.openssl}/bin/openssl rand -base64 48 | tr '+/' '-_' | tr -d '\n')
          printf 'export CLIPROXYAPI_API_KEY=%s\n' "$key" >"${envFile}"
        fi
        chmod 600 "${envFile}"
        . "${envFile}"
        test -n "''${CLIPROXYAPI_API_KEY:-}"
        sed "s|__CLIPROXYAPI_API_KEY__|$CLIPROXYAPI_API_KEY|g" \
          ${./cliproxyapi/config.yaml} >"${configFile}"
        chmod 600 "${configFile}"
      fi
    '';
  };

  launchd.user.agents.cliproxyapi = {
    environment = {
      HOME = "/Users/tomas";
      XDG_CONFIG_HOME = "/Users/tomas/.config";
      XDG_DATA_HOME = "/Users/tomas/.local/share";
    };
    command = ''
      ${cliProxyApi}/bin/cli-proxy-api --config ${configFile}
    '';
    serviceConfig = {
      KeepAlive = true;
      RunAtLoad = true;
      ProcessType = "Background";
      ThrottleInterval = 5;
      Umask = 63;
      WorkingDirectory = "/Users/tomas";
      StandardOutPath = "/Users/tomas/Library/Logs/CLIProxyAPI.log";
      StandardErrorPath = "/Users/tomas/Library/Logs/CLIProxyAPI.error.log";
    };
  };

  launchd.user.agents.openchamber = {
    path = [
      "/Users/tomas/.npm-global/bin"
      "/opt/homebrew/bin"
      "/etc/profiles/per-user/tomas/bin"
      "/run/current-system/sw/bin"
      "/usr/bin"
      "/bin"
      "/usr/sbin"
      "/sbin"
    ];
    environment = {
      HOME = "/Users/tomas";
      OPENCODE_BINARY = "/opt/homebrew/bin/opencode";
      XDG_CONFIG_HOME = "/Users/tomas/.config";
      XDG_DATA_HOME = "/Users/tomas/.local/share";
    };
    command = "${openchamberCommand}";
    serviceConfig = {
      KeepAlive = true;
      RunAtLoad = true;
      ProcessType = "Background";
      ThrottleInterval = 5;
      WorkingDirectory = "/Users/tomas";
      StandardOutPath = "/Users/tomas/Library/Logs/OpenChamber.log";
      StandardErrorPath = "/Users/tomas/Library/Logs/OpenChamber.error.log";
    };
  };
}
