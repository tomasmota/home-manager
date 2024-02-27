{
  pkgs,
  xdg,
  ...
}: {
  programs.tmux = {
    enable = true;
    keyMode = "vi";
    baseIndex = 1;
    terminal = "tmux-256color";
    prefix = "C-Space";
    disableConfirmationPrompt = true;
    escapeTime = 0;
    mouse = true;
    plugins = with pkgs; [
      tmuxPlugins.extrakto
      {
        plugin = tmuxPlugins.catppuccin;
        extraConfig = ''
          set -g @catppuccin_window_tabs_enabled on
          set -g @catppuccin_window_default_text "#W"
          set -g @catppuccin_window_current_text "#W"
        '';
      }
    ];
    extraConfig = ''
      set -ag terminal-overrides ",xterm-256color:RGB"

      # status bar on top
      set-option -g status-position top

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

      # # dont use current window name as default when renaming
      # unbind ,
      bind-key , command-prompt -p (rename-window) "rename-window '%%'"

      # reload with "r"
      bind r source-file ${xdg.configHome}/tmux/tmux.conf \; display "Reloaded!"
    '';
    historyLimit = 1000000;
  };
}
