{
  config,
  pkgs,
  ...
}: let
  agentsDir = "${config.xdg.configHome}/home-manager/agents";
  opencodeConfigFile =
    if pkgs.stdenv.isLinux
    then "opencode.json"
    else "opencode.macos.json";
in {
  # Shared configuration for AI agents (Gemini, Amp, Codex, etc.)
  # Managed via out-of-store symlinks for easy editing.

  home.file = {
    # Gemini Configuration
    ".gemini/settings.json".source =
      config.lib.file.mkOutOfStoreSymlink "${agentsDir}/gemini/settings.json";

    ".gemini/policies".source =
      config.lib.file.mkOutOfStoreSymlink "${agentsDir}/gemini/policies";

    # OpenCode Configuration
    ".config/opencode/opencode.json".source =
      config.lib.file.mkOutOfStoreSymlink "${agentsDir}/opencode/${opencodeConfigFile}";
  };
}
