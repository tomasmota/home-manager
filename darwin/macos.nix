{
  config,
  lib,
  pkgs,
  ...
}: let
  user = config.system.primaryUser;
  home = config.users.users.${user}.home;
in {
  imports = [./tern.nix];

  nixpkgs.hostPlatform = "aarch64-darwin";

  programs.zsh = {
    enable = true;
    # Home Manager owns completion and prompt initialization.
    enableGlobalCompInit = false;
    promptInit = "";
  };
  users.users.${user}.shell = pkgs.zsh;
  security.pam.services.sudo_local.touchIdAuth = true;

  nix = {
    settings = {
      download-buffer-size = 97108864;
      experimental-features = ["nix-command" "flakes"];
      # Agent-run builds do not need root-equivalent daemon trust.
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

  home-manager.users.${user} = {lib, ...}: {
    home.packages = [
      (pkgs.google-cloud-sdk.withExtraComponents [pkgs.google-cloud-sdk.components.gke-gcloud-auth-plugin])
    ];

    # nix-darwin loads user agents before HM runs as this user via launchctl asuser.
    home.activation.agentUsage = lib.hm.dag.entryAfter ["writeBoundary"] ''
      run /usr/bin/env HOME=${lib.escapeShellArg home} ${./agent-usage}/install.sh \
        || warnEcho "agent-usage: install failed; keeping the previous app"
    '';
  };

  services.tailscale.enable = true;

  launchd.user.agents = {
    # Agent Usage menu bar app (built from darwin/agent-usage in this repo; reads `omp usage`).
    # Restart on crash, but stay dead after an explicit Quit from the menu.
    agent-usage = {
      environment = {
        HOME = home;
        PATH = "/etc/profiles/per-user/${user}/bin:/run/current-system/sw/bin:/usr/bin:/bin";
      };
      command = ''
        ${home}/Applications/AgentUsage.app/Contents/MacOS/AgentUsage
      '';
      serviceConfig = {
        KeepAlive = {
          Crashed = true;
          SuccessfulExit = false;
        };
        RunAtLoad = true;
        ProcessType = "Background";
        StandardOutPath = "${home}/Library/Logs/AgentUsage.log";
        StandardErrorPath = "${home}/Library/Logs/AgentUsage.error.log";
      };
    };
  };

  homebrew = {
    enable = true;
    casks = [
      "middleclick"
      "obsidian"
      "raycast"
      "rectangle"
      "bitwarden"
      "zed"
    ];
    onActivation = {
      autoUpdate = true;
      upgrade = true;
      cleanup = "uninstall";
    };
  };
}
