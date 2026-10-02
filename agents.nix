{
  config,
  lib,
  pkgs,
  ...
}: let
  agentsDir = "${config.xdg.configHome}/home-manager/agents";
  opencodeConfigFile =
    if pkgs.stdenv.hostPlatform.isLinux
    then "opencode.json"
    else "opencode.macos.json";
  runtime = import ./agents/runtime {
    inherit pkgs;
    home = config.home.homeDirectory;
  };
in {
  home = {
    packages = [runtime.opencode];

    activation = {
      agentConfig = lib.hm.dag.entryAfter ["writeBoundary"] ''
        if [ -z "$DRY_RUN_CMD" ]; then
          ${pkgs.nodejs_24}/bin/node ${./agents/config/check.mjs} "${config.xdg.configHome}/home-manager"
        fi
      '';
      agentRuntime = lib.hm.dag.entryAfter ["agentConfig"] ''
        if [ -z "$DRY_RUN_CMD" ]; then
          ${runtime.install}
        fi
      '';
    };

    # Shared configuration for AI agents (OpenCode, etc.)
    # Managed via out-of-store symlinks for easy editing.
    file = {
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

      # The routing package is central and SHA-pinned, not locally discovered.
      ".config/opencode/subagents.jsonc".source =
        config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/subagents.jsonc";

      ".config/opencode/tui-plugins/tmux-status".source =
        config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/tui-plugins/tmux-status";

      ".config/opencode/cli.json" = {
        source = config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/cli.json";
        force = true;
      };

      ".config/opencode/tui-plugins/quota-watch".source =
        config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/tui-plugins/quota-watch";
    };
  };
}
