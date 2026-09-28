{
  config,
  lib,
  pkgs,
  ...
}: {
  nixpkgs.hostPlatform = "aarch64-darwin";

  programs.zsh.enable = true;
  users.users.tomas.shell = pkgs.zsh;
  security.pam.services.sudo_local.touchIdAuth = true;

  nix = {
    settings = {
      download-buffer-size = 97108864;
      experimental-features = ["nix-command" "flakes"];
      trusted-users = ["root" "tomas"];
      auto-optimise-store = lib.mkForce false; # do this manually below
    };

    optimise.automatic = true;
    gc = {
      automatic = true;
      options = "--delete-older-than 14d";
    };
  };

  system = {
    primaryUser = "tomas";
    defaults = {
      NSGlobalDomain = {
        ApplePressAndHoldEnabled = false;
        AppleSpacesSwitchOnActivate = true;
        InitialKeyRepeat = 15;
        KeyRepeat = 2;
        NSAutomaticWindowAnimationsEnabled = false;
      };
      dock = {
        autohide = true;
        autohide-delay = 0.0;
        autohide-time-modifier = 0.2;
        show-recents = false;
        tilesize = 60;
        mru-spaces = false;
      };
      finder = {
        AppleShowAllExtensions = true;
        FXPreferredViewStyle = "Nlsv";
        ShowStatusBar = true;
        ShowPathbar = true;
      };
      trackpad = {Clicking = true;};
    };
    stateVersion = 6;
  };

  environment.shells = [pkgs.zsh];

  home-manager.users.tomas = {lib, ...}: {
    home.packages = [
      (pkgs.google-cloud-sdk.withExtraComponents [pkgs.google-cloud-sdk.components.gke-gcloud-auth-plugin])
    ];

    # Codex Usage menu bar app: build with the system Swift toolchain and
    # install to ~/Applications when sources in this repo change.
    home.activation.codexUsage = lib.hm.dag.entryAfter ["writeBoundary"] ''
      APP_BIN="$HOME/Applications/CodexUsage.app/Contents/MacOS/CodexUsage"
      SRC_DIR="/Users/tomas/.config/home-manager/darwin/codex-usage"
      if [ ! -x "$APP_BIN" ] \
        || [ -n "$(find "$SRC_DIR" -name '*.swift' -newer "$APP_BIN" -print -quit 2>/dev/null)" ] \
        || [ "$SRC_DIR/Info.plist" -nt "$APP_BIN" ]; then
        $DRY_RUN_CMD "$SRC_DIR/install.sh"
      fi
    '';

  };

  services.tailscale.enable = true;

  # LaunchServices does not pass the user launchd environment to GUI apps.
  # Starting OpenChamber directly ensures it only connects to configured hosts.
  launchd.user.agents.openchamber-desktop = {
    environment.OPENCHAMBER_SKIP_LOCAL_SERVER = "1";
    command = ''
      /Applications/OpenChamber.app/Contents/MacOS/OpenChamber
    '';
    serviceConfig = {
      KeepAlive = true;
      RunAtLoad = true;
      ProcessType = "Interactive";
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
    command = ''
      ${pkgs.nodejs_24}/bin/node /Users/tomas/.npm-global/lib/node_modules/@openchamber/web/bin/cli.js serve --foreground --host 127.0.0.1 --port 3001
    '';
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

  # Tailscale terminates HTTPS for the MagicDNS hostname and proxies locally.
  launchd.user.agents.openchamber-tailnet = {
    command = ''
      /run/current-system/sw/bin/tailscale serve --bg --yes http://127.0.0.1:3001
    '';
    serviceConfig = {
      RunAtLoad = true;
      ProcessType = "Background";
      StandardOutPath = "/Users/tomas/Library/Logs/OpenChamber-tailnet.log";
      StandardErrorPath = "/Users/tomas/Library/Logs/OpenChamber-tailnet.error.log";
    };
  };

  # Codex Usage menu bar app (built from darwin/codex-usage in this repo).
  # Restart on crash, but stay dead after an explicit Quit from the menu.
  launchd.user.agents.codex-usage = {
    environment = {
      HOME = "/Users/tomas";
      PATH = "/Users/tomas/.local/bin:/usr/bin:/bin";
    };
    command = ''
      /Users/tomas/Applications/CodexUsage.app/Contents/MacOS/CodexUsage
    '';
    serviceConfig = {
      KeepAlive = {Crashed = true; SuccessfulExit = false;};
      RunAtLoad = true;
      ProcessType = "Background";
      StandardOutPath = "/Users/tomas/Library/Logs/CodexUsage.log";
      StandardErrorPath = "/Users/tomas/Library/Logs/CodexUsage.error.log";
    };
  };

  homebrew = {
    enable = true;
    taps = ["anomalyco/tap"];
    brews = ["anomalyco/tap/opencode-v2"];
    casks = [
      "ghostty"
      "middleclick"
      "obsidian"
      "raycast"
      "rectangle"
      "bitwarden"
      "hammerspoon"
      "zed"
    ];
    onActivation = {
      autoUpdate = true;
      upgrade = true;
      cleanup = "uninstall";
    };
  };
}
