{
  config,
  lib,
  pkgs,
  ...
}: let
  agentsDir = "${config.xdg.configHome}/home-manager/agents";
  runtime = import ./agents/runtime {
    inherit pkgs;
    home = config.home.homeDirectory;
  };
  checkConfig = ''
    ${pkgs.nodejs_24}/bin/node ${./agents/config/check.mjs} "${config.xdg.configHome}/home-manager"
  '';
in {
  # Mac-only module, imported via the nix-darwin Home Manager user. nix-darwin
  # reconciles user launchd agents before Home Manager's postActivation, so
  # darwin/cliproxyapi.nix runs this preflight from system activation instead.
  options.agents.activationPreflight = lib.mkOption {
    type = lib.types.package;
    internal = true;
    readOnly = true;
    description = "Target-user script that validates agent config and installs the locked runtime.";
  };

  config = {
    agents.activationPreflight = pkgs.writeShellScript "agent-activation-preflight" ''
      set -euo pipefail
      ${checkConfig}
      ${runtime.install}
    '';

    home = {
      packages = [runtime.opencode];

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
          config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/opencode.macos.json";

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
  };
}
