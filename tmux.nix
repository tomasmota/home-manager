{
  pkgs,
  xdg,
  ...
}: let
  acknowledgeFinishedAgent = ''if-shell -F "#{&&:#{>:#{window_active_clients},0},#{==:#{@opencode_status},done}}" "set-option -w @opencode_status idle"'';
  formatElapsed = pkgs.writeShellScript "tmux-opencode-elapsed" ''
    case "$1" in
      ""|*[!0-9]*) exit 0 ;;
    esac

    now="$(${pkgs.coreutils}/bin/date +%s)"
    elapsed=$((now - $1))
    if [ "$elapsed" -ge 3600 ]; then
      printf '%dh%dm' "$((elapsed / 3600))" "$(((elapsed / 60) % 60))"
    elif [ "$elapsed" -ge 60 ]; then
      printf '%dm%ds' "$((elapsed / 60))" "$((elapsed % 60))"
    else
      printf '%ds' "$elapsed"
    fi
  '';
  agentWindowText = builtins.concatStringsSep "" [
    " "
    "#{?#{==:#{@opencode_status},working},#[fg=#{@thm_green}]● ,}"
    "#{?#{==:#{@opencode_status},waiting},#[fg=#{@thm_yellow}]◆ ,}"
    "#{?#{==:#{@opencode_status},done},#[fg=#{@thm_crust}]#[bold]✓ ,}"
    "#{?#{==:#{@opencode_status},idle},#[fg=#{@thm_green}]○ ,}"
    "#{?#{==:#{@opencode_status},error},#[fg=#{@thm_red}]! ,}"
    "#{?#{==:#{@opencode_status},done},#[fg=#{@thm_crust}]#[bold],#[fg=#{@thm_fg}]}#W"
  ];
  agentElapsedText = builtins.concatStringsSep "" [
    "#{?#{@opencode_started_at},"
    "#[fg=#{@thm_overlay_1}] · "
    "#(${formatElapsed} #{@opencode_started_at})"
    ",}"
  ];
in {
  programs.tmux = {
    enable = true;
    shell = "${pkgs.zsh}/bin/zsh";
    sensibleOnTop = false;
    keyMode = "vi";
    baseIndex = 1;
    terminal = "tmux-256color";
    prefix = "C-Space";
    disableConfirmationPrompt = true;
    escapeTime = 0;
    mouse = true;
    plugins = with pkgs; [
      tmuxPlugins.fzf-tmux-url
      {
        plugin = tmuxPlugins.catppuccin;
        extraConfig = ''
          set -g @catppuccin_window_tabs_enabled on
          set -g @catppuccin_window_number_color "#{?#{==:#{@opencode_status},done},#{@thm_green},#{@thm_overlay_2}}"
          set -g @catppuccin_window_text_color "#{?#{==:#{@opencode_status},done},#{@thm_green},#{@thm_surface_0}}"
          set -g @catppuccin_window_text "${agentWindowText}"
          set -g @catppuccin_window_current_text "${agentWindowText}${agentElapsedText}"
          set -g @catppuccin_window_status_style "slanted"
        '';
      }
    ];
    extraConfig = ''
      set -ag terminal-overrides ",xterm-256color:RGB"
      set -as terminal-features ",xterm*:extkeys"
      set -as terminal-features ",xterm-ghostty:hyperlinks"
      set -s extended-keys always

      # escape sequence passthrough
      set -g allow-passthrough all
      set -g focus-events on
      set -s set-clipboard on

      # status bar on top
      set-option -g status-position top
      set-option -g status-interval 1

      # hide status on the right (hostname, time and date)
      set-option -g status-right ""
      set-option -g status-left ""

      # Clear completed-work notifications when their window is viewed
      set-hook -g session-window-changed[900] '${acknowledgeFinishedAgent}'
      set-hook -g client-attached[900] '${acknowledgeFinishedAgent}'
      set-hook -g client-session-changed[900] '${acknowledgeFinishedAgent}'

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

      # Remove the old agent picker binding from already-running servers
      unbind -q a

      bind -T copy-mode-vi v send -X begin-selection
      bind -T copy-mode-vi y send -X copy-selection-and-cancel

      # kill pane with "q"
      unbind x
      bind q kill-pane
      bind C-q kill-window

      # # dont use current window name as default when renaming
      # unbind ,
      bind-key , command-prompt -p (rename-window) "rename-window '%%'"

      # reload with "r"
      bind r source-file ${xdg.configHome}/tmux/tmux.conf \; display "Reloaded!"
    '';
    historyLimit = 1000000;
  };
}
