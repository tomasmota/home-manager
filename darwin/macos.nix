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
        InitialKeyRepeat = 15;
        KeyRepeat = 2;
      };
      dock = {
        autohide = true;
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

  services.tailscale.enable = true;

  launchd.user.agents.openchamber = {
    path = [
      "/Users/tomas/.npm-global/bin"
      "/etc/profiles/per-user/tomas/bin"
      "/run/current-system/sw/bin"
      "/usr/bin"
      "/bin"
      "/usr/sbin"
      "/sbin"
    ];
    environment = {
      HOME = "/Users/tomas";
      OPENCODE_BINARY = "/Users/tomas/.npm-global/bin/opencode";
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

  homebrew = {
    enable = true;
    casks = [
      "ghostty"
      "middleclick"
      "obsidian"
      "raycast"
      "rectangle"
      "vivaldi"
      "bitwarden"
    ];
    onActivation = {
      autoUpdate = true;
      upgrade = true;
      cleanup = "zap";
    };
  };
}
