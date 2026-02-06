{
  pkgs,
  fontSize,
  lib,
  ...
}: {
  programs.ghostty = {
    enable = true;

    # install through package manager, configure through home-manager
    package = null;
    systemd.enable = false;

    enableZshIntegration = true;
    settings = {
      "theme" = "Catppuccin Mocha";
      "fullscreen" = lib.mkIf pkgs.stdenv.isLinux true;
      "font-size" = fontSize;
    };
  };
}
