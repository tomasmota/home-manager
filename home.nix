{ config, pkgs, ... }:

rec {
  home.username = "tomas";
  home.homeDirectory = "/home/tomas";

  # This value determines the Home Manager release that your configuration is
  # compatible with. This helps avoid breakage when a new Home Manager release
  # introduces backwards incompatible changes.
  #
  # You should not change this value, even if you update Home Manager. If you do
  # want to update the value, then make sure to first check the Home Manager
  # release notes.
  home.stateVersion = "23.05"; # Please read the comment before changing.

  home.packages = with pkgs; [
    neovim
    fd
    ripgrep
    openssh
    kubectl
    exa
    ffmpeg
    eza
  ];

  programs.zsh = {
    enable = true;
    enableAutosuggestions = true;
    enableCompletion = true;
    dotDir = ".config/zsh";
    history = {
      path = "${config.xdg.cacheHome}/zsh_history";
      save = 1000000;
      extended = true;
      ignoreDups = true;
      share = true;
    };

    sessionVariables = {
      XDG_CONFIG_HOME = "${xdg.configHome}";
      EDITOR = "nvim";
    };
  
    shellAliases = {
      l = "eza --color auto";
      ls = "eza -G --color auto -a -s type";
      ll = "eza -l --color always -a -s type";
  
      hm = "home-manager";
      nv = "nvim";
      k = "kubectl";

      # git aliases
      g = "git";
      ga = "git add";
      gaa = "git add .";
      gb = "git branch";
      gbd = "git branch -d";
      gba = "git branch -a";
      gc = "git commit --message";
      gsw = "git switch";
      gco = "git checkout";
      gd = "git diff";
      gl = "git pull";
      gp = "git push -u";
      gst = "git status";
     };
  };

  programs.fzf = {
    enable = true;
    enableZshIntegration = true;
    tmux.enableShellIntegration = true;
  };

  programs.starship = {
    enable = true;
    enableZshIntegration = true;
  };

  programs.tmux = {
    enable = true;
    keyMode = "vi";
    baseIndex = 1;
    prefix = "C-Space";
    disableConfirmationPrompt = true;
    escapeTime = 0;
    mouse = true;
    extraConfig = ''
      set-option -g default-terminal "screen-256color"
      set-option -ga terminal-overrides ",xterm-256color:Tc"
      set -g mouse on

      # hide status on the right (hostname, time and date)
      set-option -g status-right ""

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
      bind r source-file $XDG_CONFIG_HOME/tmux/tmux.conf \; display "Reloaded!"
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
    package = pkgs.gitFull;
    userEmail = "tomasrebelomota@gmail.com";
    userName = "tomasmota";
    extraConfig = {
      init.defaultBranch = "main";
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

  # Let Home Manager install and manage itself.
  programs.home-manager.enable = true;
}
