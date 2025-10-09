_:
{
  programs.ghostty = {
    enable = true;
    # install through package manager, configure through home-manager
    package = null;
    settings = {
      "theme" = "Catppuccin Mocha";
      "fullscreen" = true;
      "mouse-scroll-multiplier" = 1;
    };
  };
}
