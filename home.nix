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
    gcc
    glow
    unzip
    tree
    findutils
    bat
    tree-sitter
    xclip
    neovim

    # code
    nodejs
    go_1_22
    gotools
    cargo
    terraform

    # formatting / linting
    nodePackages.prettier
    alejandra # nix formatting
    statix # nix linter

    # k8s stuff
    kubernetes-helm
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
