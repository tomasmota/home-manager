{config, ...}: let
  agentsDir = "${config.xdg.configHome}/home-manager/agents";
in {
  # Shared user instructions and public skills, owned in this checkout.
  home.file = {
    ".agents/skills".source =
      config.lib.file.mkOutOfStoreSymlink "${agentsDir}/skills";
    ".agents/AGENTS.md".source =
      config.lib.file.mkOutOfStoreSymlink "${agentsDir}/global/AGENTS.md";
  };
}
