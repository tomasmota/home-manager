{
  config,
  pkgs,
  ...
}: rec {
  home.username = "tomas";
  home.homeDirectory = "/home/tomas";

  xdg = {
    enable = true;

    configHome = "${home.homeDirectory}/.config";
    dataHome = "${home.homeDirectory}/.local/share";
    cacheHome = "${home.homeDirectory}/.cache";
  };

  imports = [
    ./shell/zsh.nix
    (import ./git.nix {inherit pkgs home;})
    (import ./tmux.nix {inherit pkgs xdg;})
  ];

  home.packages = with pkgs; [
    fd
    dua
    jq
    ripgrep
    openssh
    ffmpeg
    eza
    gnumake
    gh
    tldr
    dive
    wget
    wslu
    go_1_22
    gcc
    cargo
    nodejs
    glow
    unzip
    tree
    findutils
    bat
    tree-sitter
    nodePackages.prettier
    xclip
    lazygit
    neovim

    # formatters and linters
    eslint_d # js and ts
    yamlfmt # yaml
    hadolint # dockerfiles
    alejandra # nix formatting
    statix # nix linter
    hclfmt # hcl formatter

    # k8s stuff
    tektoncd-cli
    openshift
    pinniped
    kubectl
    kind
    k9s
  ];

  xdg.configFile = {
    nvim = {
      source =
        config.lib.file.mkOutOfStoreSymlink
        "${xdg.configHome}/home-manager/nvim";
      recursive = true;
    };
  };

  programs.direnv = {
    enable = true;
    enableZshIntegration = true;
    nix-direnv.enable = true;
  };

  home.file.".config/alacritty".source = ./alacritty;

  home.file.".config/yamlfmt/.yamlfmt".text = ''
    formatter:
      type: basic
      retain_line_breaks: true
  '';

  programs.home-manager.enable = true;
  home.stateVersion = "23.05"; # Don't change this
}
