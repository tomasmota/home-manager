# omp auth broker + auth gateway (the "Claude proxy" replacement candidate).
#
# Mirrors cliproxyapi.nix's launchd patterns: loopback-only, KeepAlive, logs
# under ~/Library/Logs. CLIProxyAPI on 8317 keeps running untouched for
# OpenCode; these services are additive. Broker default port 8765, gateway
# default port 4000 — verified not to clash with 8317 (CLIProxyAPI) or 3001
# (OpenChamber). Retiring CLIProxyAPI is a later, explicit decision after the
# omp soak; see agents/omp/README.md.
{
  config,
  lib,
  pkgs,
  omp,
  ...
}: let
  user = "tomas";
  ompBin = "${omp.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/omp";
  brokerUrl = "http://127.0.0.1:8765";
in {
  launchd.user.agents.omp-auth-broker = {
    environment = {
      HOME = "/Users/${user}";
      XDG_CONFIG_HOME = "/Users/${user}/.config";
      XDG_DATA_HOME = "/Users/${user}/.local/share";
    };
    command = "${ompBin} auth-broker serve --bind=127.0.0.1:8765";
    serviceConfig = {
      KeepAlive = true;
      RunAtLoad = true;
      ProcessType = "Background";
      ThrottleInterval = 5;
      Umask = 63;
      WorkingDirectory = "/Users/${user}";
      StandardOutPath = "/Users/${user}/Library/Logs/OMPAuthBroker.log";
      StandardErrorPath = "/Users/${user}/Library/Logs/OMPAuthBroker.error.log";
    };
  };

  launchd.user.agents.omp-auth-gateway = {
    environment = {
      HOME = "/Users/${user}";
      XDG_CONFIG_HOME = "/Users/${user}/.config";
      XDG_DATA_HOME = "/Users/${user}/.local/share";
      # The gateway is itself a broker client; KeepAlive retries until the
      # broker answers, so boot ordering needs no explicit dependency.
      OMP_AUTH_BROKER_URL = brokerUrl;
    };
    command = "${ompBin} auth-gateway serve --bind=127.0.0.1:4000";
    serviceConfig = {
      KeepAlive = true;
      RunAtLoad = true;
      ProcessType = "Background";
      ThrottleInterval = 5;
      Umask = 63;
      WorkingDirectory = "/Users/${user}";
      StandardOutPath = "/Users/${user}/Library/Logs/OMPAuthGateway.log";
      StandardErrorPath = "/Users/${user}/Library/Logs/OMPAuthGateway.error.log";
    };
  };
}
