{
  config,
  pkgs,
  lib,
  ...
}: {
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

      envExtra = ''
        export PATH="$PATH:${config.home.homeDirectory}/.local/bin"
        export PATH="$PATH:${config.home.homeDirectory}/.cargo/bin"
        export PATH="$PATH:${config.home.homeDirectory}/go/bin"
        export PATH="$PATH:${config.home.homeDirectory}/.npm-global/bin"
        export PATH="$PATH:${config.home.homeDirectory}/.opencode/bin"
        export EDITOR="nvim"
        export TFE_PARALLELISM="100"
        export DIRENV_LOG_FORMAT=""
        export MANPAGER='nvim +Man!'
        export DOCKER_BUILDKIT="1"
        export RCLONE_FAST_LIST="true"
      '';

      plugins = [
        {
          name = "vi-mode";
          src = pkgs.zsh-vi-mode;
          file = "share/zsh-vi-mode/zsh-vi-mode.plugin.zsh";
        }
      ];

      completionInit = ''
        autoload -U compinit
        zstyle ':completion:*' menu select
        zmodload zsh/complist
        compinit -C
      '';

      initContent = lib.mkOrder 550 (''
          autoload -z edit-command-line
          zle -N edit-command-line

          zvm_after_init() {
            eval "$(atuin init zsh --disable-up-arrow)"
            zvm_bindkey viins '^O' accept-line
            zvm_bindkey vicmd 'v' edit-command-line
          }

          setopt menu_complete
          unsetopt beep

          if command -v wt >/dev/null 2>&1; then
            eval "$(command wt config shell init zsh)"
          fi

          if [[ -n $TMUX && -n $TMUX_PANE ]]; then
            zmodload zsh/datetime
            typeset -gi _tmux_command_started_at=0

            _tmux_command_preexec() {
              _tmux_command_started_at=0

              local -a command_words
              command_words=(''${(z)2})
              local command_name=$command_words[1]
              command_name=$command_name:t

              # Persistent interactive apps are workspaces, not pending commands.
              case $command_name in
                opencode|nvim|vim|vi|view|less|more|most|man|info|ssh|mosh|tmux|top|htop|btop|watch|k9s|lazygit)
                  return 0
                  ;;
              esac

              _tmux_command_started_at=$EPOCHSECONDS
              tmux set-option -w -t "$TMUX_PANE" @shell_command_status running \; \
                set-option -w -t "$TMUX_PANE" @shell_command_started_at "$_tmux_command_started_at" \; \
                set-option -w -u -t "$TMUX_PANE" @shell_command_duration >/dev/null 2>&1
              return 0
            }

            _tmux_command_precmd() {
              local exit_status=$?
              local started_at=$_tmux_command_started_at
              _tmux_command_started_at=0
              ((started_at > 0)) || return 0

              local elapsed=$((EPOCHSECONDS - started_at))
              local duration state
              if ((elapsed >= 3600)); then
                printf -v duration '%d:%02d:%02d' \
                  $((elapsed / 3600)) \
                  $(((elapsed / 60) % 60)) \
                  $((elapsed % 60))
              else
                printf -v duration '%02d:%02d' $((elapsed / 60)) $((elapsed % 60))
              fi
              if ((exit_status == 0)); then
                state=done
              else
                state=error
              fi

              local clear_status="set-option -w -t $TMUX_PANE @shell_command_status idle ; set-option -w -u -t $TMUX_PANE @shell_command_started_at ; set-option -w -u -t $TMUX_PANE @shell_command_duration"
              local completed_status="set-option -w -t $TMUX_PANE @shell_command_status $state ; set-option -w -u -t $TMUX_PANE @shell_command_started_at ; set-option -w -t $TMUX_PANE @shell_command_duration $duration"
              tmux if-shell -F -t "$TMUX_PANE" '#{window_active_clients}' \
                "$clear_status" "$completed_status" >/dev/null 2>&1
              return 0
            }

            _tmux_command_zshexit() {
              tmux set-option -w -t "$TMUX_PANE" @shell_command_status idle \; \
                set-option -w -u -t "$TMUX_PANE" @shell_command_started_at \; \
                set-option -w -u -t "$TMUX_PANE" @shell_command_duration >/dev/null 2>&1
              return 0
            }

            autoload -Uz add-zsh-hook
            add-zsh-hook preexec _tmux_command_preexec
            add-zsh-hook precmd _tmux_command_precmd
            add-zsh-hook zshexit _tmux_command_zshexit
          fi

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
        ''
        + import ./functions.nix {inherit config;});

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
