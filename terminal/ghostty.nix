_:
{
  programs.ghostty = {
    enable = true;
    # install through package manager, configure through home-manager
    package = null;
    settings = {
      "theme" = "catppuccin-mocha";
      "fullscreen" = true;
    };
  };
}
