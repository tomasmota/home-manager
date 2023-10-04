{ config, pkgs, ... }:

rec {
  home.username = "tomas";
  home.homeDirectory = "/home/tomas";

  imports = [
    ./zsh.nix 
  ];

  home.packages = with pkgs; [
    fd
    dua
    jq
    ripgrep
    openssh
    kubectl
    ffmpeg
    eza
    gnumake
    gh
    dive
    wget
    curl
    go_1_21
    gcc
    cargo
    nodejs
  ];

  programs.neovim = {
    enable = true;
    extraLuaConfig = ''
      :luafile ~/nvim/init.lua
    '';
  };

  xdg.configFile.nvim = {  
    source = ./nvim;  
    recursive = true;  
  };

  programs.tmux = {
    enable = true;
    keyMode = "vi";
    baseIndex = 1;
    terminal = "tmux-256color";
    prefix = "C-Space";
    disableConfirmationPrompt = true;
    escapeTime = 0;
    mouse = true;
    plugins = [ pkgs.tmuxPlugins.catppuccin ];
    extraConfig = ''
      set -ag terminal-overrides ",xterm-256color:RGB"

      set -g mouse on

      # hide status on the right (hostname, time and date)
      set-option -g status-right ""

      # Renumber windows to match positions
      set -g renumber-windows on

      # Create windows in current path, instead of path where session was created. Create with empty name
      bind c new-window -c "#{pane_current_path}" -n ""

      # split with "v" and "s"
      bind v split-window -h -c "#{pane_current_path}"
      bind s split-window -v -c "#{pane_current_path}"
      bind h select-pane -L
      bind j select-pane -D
      bind k select-pane -U
      bind l select-pane -R

      # Resize in bigger units, using vim keys
      bind -r C-j resize-pane -D 5
      bind -r C-k resize-pane -U 5
      bind -r C-h resize-pane -L 15
      bind -r C-l resize-pane -R 15

      bind Space last-window

      bind -T copy-mode-vi v send -X begin-selection
      bind -T copy-mode-vi y send -X copy-pipe-and-cancel "reattach-to-user-namespace pbcopy"

      # kill pane with "q"
      unbind x
      bind q kill-pane
      bind C-q kill-window

      # dont use current window name as default when renaming
      unbind ,
      bind-key , command-prompt -p (rename-window) "rename-window '%%'"

      # reload with "r"
      bind r source-file ${xdg.configHome}/tmux/tmux.conf \; display "Reloaded!"

      set -g @catppuccin_window_tabs_enabled on
    '';
    historyLimit = 1000000;
  };

  programs.direnv = {
    enable = true;
    enableZshIntegration = true;
    nix-direnv.enable = true;
  };

  programs.git = {
    enable = true;
    difftastic.enable = true;
    package = pkgs.gitFull;
    userEmail = "tomasrebelomota@gmail.com";
    userName = "tomasmota";
    extraConfig = {
      init.defaultBranch = "main";
      push.autoSetupRemote = true;
    };
    ignores = [ "/.direnv" ];
  };

  # Home Manager is pretty good at managing dotfiles. The primary way to manage
  # plain files is through 'home.file'.
  home.file = {
    # # Building this configuration will create a copy of 'dotfiles/screenrc' in
    # # the Nix store. Activating the configuration will then make '~/.screenrc' a
    # # symlink to the Nix store copy.
    # ".screenrc".source = dotfiles/screenrc;

    # # You can also set the file content immediately.
    # ".gradle/gradle.properties".text = ''
    #   org.gradle.console=verbose
    #   org.gradle.daemon.idletimeout=3600000
    # '';
  };

  xdg = {
    enable = true;

    configHome = "${home.homeDirectory}/.config";
    dataHome = "${home.homeDirectory}/.local/share";
    cacheHome = "${home.homeDirectory}/.cache";
  };

  programs.home-manager.enable = true;
  home.stateVersion = "23.05"; # Don't change this
}
