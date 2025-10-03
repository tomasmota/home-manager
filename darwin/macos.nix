{
  config,
  lib,
  pkgs,
  ...
}: {
  nixpkgs.hostPlatform = "aarch64-darwin";
  programs.zsh.enable = true;
  users.users.tomas.shell = pkgs.zsh;
  security.pam.services.sudo_local.touchIdAuth = true; # optional nice-to-have

  nix = {
    settings = {
      experimental-features = ["nix-command" "flakes"];
      # keep PATH sane, speed things up, and make CI reproducible
      auto-optimise-store = lib.mkForce false; # see note below
      trusted-users = ["root" "tomas"];
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
        tilesize = 48;
        mru-spaces = false;
      };
      finder = {
        AppleShowAllExtensions = true;
        FXPreferredViewStyle = "Nlsv"; # list view
        ShowStatusBar = true;
        ShowPathbar = true;
      };
      trackpad = {Clicking = true;};
    };
    stateVersion = 6;
  };

  homebrew = {
    enable = true;
    casks = [
      "ghostty"
      "middleclick"
      "vivaldi"
    ];
    onActivation = {
      autoUpdate = true;
      upgrade = true;
      cleanup = "zap";
    };
  };
}
