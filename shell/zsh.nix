{config, ...}: {
  programs = {
    zsh = {
      enable = true;
      autosuggestion.enable = true;
      enableCompletion = true;
      syntaxHighlighting.enable = true;
      dotDir = ".config/zsh";
      autocd = true;
      defaultKeymap = "emacs";
      history = {
        path = "${config.xdg.cacheHome}/zsh_history";
        save = 1000000;
        extended = true;
        ignoreDups = true;
        share = true;
        ignorePatterns = ["l*"];
      };

      oh-my-zsh = {
        enable = true;
        plugins = ["git"];
      };

      sessionVariables = {
        DIRENV_LOG_FORMAT = "";
        XDG_CONFIG_HOME = "${config.xdg.configHome}";
        EDITOR = "nvim";
        MANPAGER = "nvim +Man!";
        SRC_ENDPOINT = "https://sourcegraph.com";
        TF_PLUGIN_CACHE_DIR = "${config.home.homeDirectory}/.terraform.d/plugin-cache";
        DOCKER_BUILDKIT = 1;
        RCLONE_FAST_LIST = true;
      };

      initExtraBeforeCompInit =
        ''
          setopt menu_complete
          unsetopt beep

          # FZF
          _fzf_compgen_path() {
            fd --hidden --follow --exclude ".git" . "$1"
          }
          _fzf_compgen_dir() {
            fd --type d --hidden --follow --exclude ".git" . "$1"
          }
        ''
        + import ./functions.nix {inherit config;};

      initExtra = ''
        if [[ -f "${config.xdg.configHome}/home-manager/secrets.env" ]]; then
          source ${config.xdg.configHome}/home-manager/secrets.env
        fi
      '';

      envExtra = ''
        PATH=$PATH:${config.home.homeDirectory}/.cargo/bin
        PATH=$PATH:${config.home.homeDirectory}/go/bin
      '';

      shellAliases = import ./aliases.nix {inherit config;};
    };

    fzf = {
      enable = true;
      defaultOptions = [
        "--layout=reverse"
        "--height=40"
        ''--bind="ctrl-o:accept"''
      ];
    };

    atuin = {
      enable = true;
      flags = ["--disable-up-arrow"];
      enableZshIntegration = true;
    };

    starship = {
      enable = true;
      enableZshIntegration = true;
      settings = {
        format = ''$directory$cmd_duration$terraform$kubernetes$git_branch$git_status$fill$gcloud$line_break$character'';
        fill.symbol = " ";
        gcloud = {
          style = "bold yellow";
          format = ''[$project]($style) '';
        };
        terraform = {
          format = "[🌍]($style) ";
        };
        kubernetes = {
          disabled = false;
          style = "blue bold";
          contexts = [
            {
              context_pattern = "prod";
              style = "red bold";
            }
          ];
          format = ''on ⛵ [$context \($namespace\)]($style) '';
        };
      };
    };
  };
}
