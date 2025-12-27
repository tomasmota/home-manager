{pkgs, fontSize, ...}: {
  programs.ghostty = {
    enable = true;

    # install through package manager, configure through home-manager
    package = null;
    systemd.enable = false;

    enableZshIntegration = true;
    settings = {
      "theme" = "Catppuccin Mocha";
      "fullscreen" = true;
      "font-size" = fontSize;
    };
  };
}
