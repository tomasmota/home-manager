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

  services.tailscale.enable = true;

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
