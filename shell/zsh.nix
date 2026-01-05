{config, pkgs, ...}: {
  programs = {
    zsh = {
      enable = true;
      autosuggestion.enable = true;
      enableCompletion = true;
      syntaxHighlighting.enable = true;
      dotDir = "${config.xdg.configHome}/zsh";
      autocd = true;
      history = {
        path = "${config.xdg.cacheHome}/zsh_history";
        save = 1000000;
        extended = true;
        ignoreDups = true;
        share = true;
        ignorePatterns = ["l*"];
      };
      plugins = [
        {
          name = "vi-mode";
          src = pkgs.zsh-vi-mode;
          file = "share/zsh-vi-mode/zsh-vi-mode.plugin.zsh";
        }
      ];

      sessionVariables = {
        DIRENV_LOG_FORMAT = "";
        XDG_CONFIG_HOME = "${config.xdg.configHome}";
        MANPAGER = "nvim +Man!";
        SRC_ENDPOINT = "https://sourcegraph.com";
        DOCKER_BUILDKIT = 1;
        RCLONE_FAST_LIST = true;
      };

      completionInit = ''
        autoload -U compinit
        zstyle ':completion:*' menu select
        zmodload zsh/complist
        compinit -C
      '';

      initContent = ''
        setopt menu_complete
        unsetopt beep

        # FZF
        _fzf_compgen_path() {
          fd --hidden --follow --exclude ".git" . "$1"
        }
        _fzf_compgen_dir() {
          fd --type d --hidden --follow --exclude ".git" . "$1"
        }
        if [[ -f "${config.xdg.configHome}/home-manager/secrets.env" ]]; then
          source ${config.xdg.configHome}/home-manager/secrets.env
        fi

        # zsh-vi-mode breaks atuin ctrl-r
        zvm_after_init_commands+=(eval "$(atuin init zsh --disable-up-arrow)")
        # zsh-vi-mode breaks ctrl-o to accept-line
        zvm_after_init_commands+=("zvm_bindkey viins '^O' accept-line")
      '' + import ./functions.nix {inherit config;};

      envExtra = ''
        PATH=$PATH:${config.home.homeDirectory}/.cargo/bin
        PATH=$PATH:${config.home.homeDirectory}/go/bin
        PATH=$PATH:${config.home.homeDirectory}/.npm-global/bin
        EDITOR=nvim
        TFE_PARALLELISM=100;
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
    };

    starship = {
      enable = true;
      enableZshIntegration = true;
      settings = {
        command_timeout = 1500;
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

    direnv = {
      enable = true;
      enableZshIntegration = true;
      nix-direnv.enable = true;
    };
  };
}
