{
  config,
  pkgs,
  ...
}: let
  agentsDir = "${config.xdg.configHome}/home-manager/agents";
  opencodeConfigFile =
    if pkgs.stdenv.hostPlatform.isLinux
    then "opencode.json"
    else "opencode.macos.json";
in {
  # Shared configuration for AI agents (OpenCode, etc.)
  # Managed via out-of-store symlinks for easy editing.

  home.file = {
    # Shared agent-compatible skills
    ".agents/skills".source =
      config.lib.file.mkOutOfStoreSymlink "${agentsDir}/skills";

    ".agents/AGENTS.md".source =
      config.lib.file.mkOutOfStoreSymlink "${agentsDir}/global/AGENTS.md";

    # OpenCode Configuration
    ".config/opencode/AGENTS.md" = {
      source = config.lib.file.mkOutOfStoreSymlink "${agentsDir}/global/AGENTS.md";
      force = true;
    };

    ".config/opencode/opencode.json".source =
      config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/${opencodeConfigFile}";

    # Generates the shared agents (general, coder, explore, ...) from
    # opencode/subagents.jsonc; edits to that file apply without a switch.
    ".config/opencode/plugins/agent-routes".source =
      config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/plugins/agent-routes";

    ".config/opencode/tui-plugins/tmux-status".source =
      config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/tui-plugins/tmux-status";

    ".config/opencode/cli.json" = {
      source = config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/cli.json";
      force = true;
    };

    ".config/opencode/tui-plugins/quota-watch".source =
      config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/tui-plugins/quota-watch";
  };
}
