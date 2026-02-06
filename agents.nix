{
  config,
  pkgs,
  ...
}: let
  agentsDir = "${config.xdg.configHome}/home-manager/agents";
in {
  # Shared configuration for AI agents (Gemini, Amp, Codex, etc.)
  # Managed via out-of-store symlinks for easy editing.

  # Gemini Configuration
  home.file.".gemini/settings.json".source =
    config.lib.file.mkOutOfStoreSymlink "${agentsDir}/gemini/settings.json";

  home.file.".gemini/policies".source =
    config.lib.file.mkOutOfStoreSymlink "${agentsDir}/gemini/policies";
}
