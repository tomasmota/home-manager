{ config, pkgs, ... }:
{
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
      XDG_CONFIG_HOME = "${config.xdg.configHome}";
      EDITOR = "nvim";
      MANPAGER = "nvim +Man!";
      TF_PLUGIN_CACHE_DIR="${config.home.homeDirectory}/.terraform.d/plugin-cache";
    };

    initExtraBeforeCompInit = ''
      setopt menu_complete
      unsetopt beep

      # ZSH settings (helpful for wsl)
      ZSH_HIGHLIGHT_MAXLENGTH=60
      ZSH_HIGHLIGHT_DIRS_BLACKLIST=(/mnt/c)

      # FZF
      _fzf_compgen_path() {
        fd --hidden --follow --exclude ".git" . "$1"
      }
      _fzf_compgen_dir() {
        fd --type d --hidden --follow --exclude ".git" . "$1"
      }
    '';
  
    shellAliases = {
      # home-manager
      hm = "home-manager";
      hms = "home-manager switch";
      hme = "nvim ${config.xdg.configHome}/home-manager/home.nix";

      # Misc
      ls = "eza -G --color auto -a -s type";
      la = "eza -l --color always -a -s type";
      l = "eza -l --color always -a -s type";
      nv = "nvim";
      tree = "tree -I 'node_modules|dist|coverage'";
      dra = "direnv allow";
      lg = "fd --type=d --max-depth=1";

      # Git
      gpt = "git push --tags";
      gld = "git log -p --oneline --ext-diff";
      gD = "git diff HEAD~1";
      gprune = ''git remote prune origin && git for-each-ref --format "%(refname:short)" refs/heads | grep -v "master\|main" | xargs git branch -D'';

      # Terraform
      tfi = "terraform init";
      tfp = "terraform plan";
      tfa = "terraform apply";
      tfd = "terraform destroy";
      tfs = "terraform show";
      tfv = "terraform validate";

      # Yarn
      yd = "yarn dev";
      yi = "yarn install";
      yf = "yarn prettier --write .";

      # Files
      # Fuzzy find tree and cd into folder
      cdf = ''cd $(fd --type directory | fzf --preview "tree -I \"node_modules|dist|coverage\" -C {}")''; 
      # Fuzzy find over all repos under ~/dev
      cdr = ''cd $(fd --search-path ~/dev --type directory --hidden "^\.git$" | xargs -I {} dirname {} | fzf --preview "tree -I \"node_modules|dist|coverage\" -C {}")''; 
      # Fuzzy find tree and open folder in neovim
      nvd = ''nv $(fd --type directory | fzf --preview "tree -I \"node_modules|dist|coverage\" -C {}")'';
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
}
