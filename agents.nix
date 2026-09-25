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

    ".config/opencode/agents/general.md" = {
      source = config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/agents/general.md";
      force = true;
    };

    ".config/opencode/agents/explore.md" = {
      source = config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/agents/explore.md";
      force = true;
    };

    ".config/opencode/agents/free.md" = {
      source = config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/agents/free.md";
      force = true;
    };

    ".config/opencode/agents/reviewer.md" = {
      source = config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/agents/reviewer.md";
      force = true;
    };

    # NOTE: infra-investigate.md is intentionally NOT managed here. It is
    # Signicat-specific and lives only as a local file in
    # ~/.config/opencode/agents/. Do not add a symlink entry for it.

    ".config/opencode/tui-plugins/tmux-status".source =
      config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/tui-plugins/tmux-status";

    ".config/opencode/plugins/auto-approve-jev.js".source =
      config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/plugins/auto-approve-jev.js";

    ".config/opencode/plugins/lib".source =
      config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/plugins/lib";

    ".config/opencode/cli.json" = {
      source = config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/cli.json";
      force = true;
    };

    ".config/opencode/tui-plugins/quota-watch".source =
      config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/tui-plugins/quota-watch";
  };
}
