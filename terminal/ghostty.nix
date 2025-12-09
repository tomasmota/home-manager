{pkgs, ... }: {
  programs.ghostty = {
    enable = true;

    # install through package manager, configure through home-manager
    package = null;
    systemd.enable = false;

    enableZshIntegration = true;
    settings = {
      "theme" = "Catppuccin Mocha";
      "fullscreen" = !pkgs.stdenv.isDarwin; # only want fullscreen on mac
      "mouse-scroll-multiplier" = 1;
    };
  };
}
