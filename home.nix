{ config, pkgs, ... }:

rec {
  home.username = "tomas";
  home.homeDirectory = "/home/tomas";

  home.packages = with pkgs; [
    neovim
    fd
    dua
    jq
    ripgrep
    openssh
    kubectl
    ffmpeg
    eza
    gnumake
  ];

  programs.zsh = {
    enable = true;
    enableAutosuggestions = true;
    enableCompletion = true;
    dotDir = ".config/zsh";
    autocd = true;
    defaultKeymap = "emacs";
    history = {
      path = "${config.xdg.cacheHome}/zsh_history";
      save = 1000000;
      extended = true;
      ignoreDups = true;
      share = true;
      ignorePatterns = [ "l*" ];
    };

    oh-my-zsh = {
      enable = true;
      plugins = [ 
        "git"
        "z"
        "kubectl"
        "docker"
        "history"
      ];
      custom = "$HOME/.config/zsh_nix/custom";
    };

    plugins = [
      {
        name = "zsh-syntax-highlighting";
        src = pkgs.fetchFromGitHub {
          owner = "zsh-users";
          repo = "zsh-syntax-highlighting";
          rev = "0.7.0";
          sha256 = "sha256-eRTk0o35QbPB9kOIV0iDwd0j5P/yewFFISVS/iEfP2g=";
        };
      }
    ];

    sessionVariables = {
      XDG_CONFIG_HOME = "${xdg.configHome}";
      EDITOR = "nvim";
      MANPAGER = "nvim +Man!";
    };
  
    shellAliases = {
      ls = "eza -G --color auto -a -s type";
      la = "eza -l --color always -a -s type";
  
      hm = "home-manager";
      hms = "home-manager switch";
      nv = "nvim";

      # Git
      gpt="git push --tags";
      gld="git log -p --oneline --ext-diff";
      gD="git diff HEAD~1";
      gprune=''git remote prune origin && git for-each-ref --format "%(refname:short)" refs/heads | grep -v "master\|main" | xargs git branch -D'';

      # Terraform
      tfi="terraform init";
      tfp="terraform plan";
      tfa="terraform apply";
      tfd="terraform destroy";
      tfs="terraform show";
      tfv="terraform validate";

      # Yarn
      yd="yarn dev";
      yi="yarn install";
      yf="yarn prettier --write .";

      # Files
      # Fuzzy find tree and cd into folder
      cdf=''cd $(fd --type directory | fzf --preview "tree -I \"node_modules|dist|coverage\" -C {}")''; 

      # Fuzzy find over all repos under ~/dev
      cdr=''cd $(fd --search-path ~/dev --type directory --hidden "^\.git$" | xargs -I {} dirname {} | fzf --preview "tree -I \"node_modules|dist|coverage\" -C {}")''; 

      # Fuzzy find tree and open folder in neovim
      nvd=''nv $(fd --type directory | fzf --preview "tree -I \"node_modules|dist|coverage\" -C {}")'';
    };
  };

  programs.fzf = {
    enable = true;
    defaultOptions = [ "--layout=reverse" "--height=40" ];
  };

  programs.atuin = {
    enable = true;
    flags = ["--disable-up-arrow"];
    enableZshIntegration = true;
  };

  programs.starship = {
    enable = true;
    enableZshIntegration = true;
    settings = {
      gcloud.disabled = true;
      aws.disabled = true;
      cmd_duration.disabled = true;
    };
  };

  programs.tmux = {
    enable = true;
    keyMode = "vi";
    baseIndex = 1;
    terminal = "screen-256color";
    prefix = "C-Space";
    disableConfirmationPrompt = true;
    escapeTime = 0;
    mouse = true;
    plugins = [ pkgs.tmuxPlugins.catppuccin ];
    extraConfig = ''
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
