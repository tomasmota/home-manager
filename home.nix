{
  config,
  pkgs,
  home,
  ...
}: rec {
  xdg = {
    enable = true;

    configHome = "${config.home.homeDirectory}/.config";
    dataHome = "${config.home.homeDirectory}/.local/share";
    cacheHome = "${config.home.homeDirectory}/.cache";
  };

  imports = [
    ./shell/zsh.nix
    (import ./git.nix {inherit pkgs config;})
    (import ./tmux.nix {inherit pkgs xdg;})
  ];

  fonts.fontconfig.enable = true;

  home.packages = with pkgs; [
    fd # better find
    dua # better du
    duf # better df
    bottom # better top
    dogdns # better dig
    ripgrep # better grep
    eza # better ls
    bat # better cat
    jq
    yq-go
    openssh
    ffmpeg
    gnumake
    gh
    tldr
    dive
    wget
    gcc
    glow
    unzip
    tree
    findutils
    tree-sitter
    xclip
    rclone
    neovim
    grpcurl

    # fonts
    nerd-fonts.geist-mono

    # code
    lua
    go_1_23
    gotools
    protobuf
    cargo
    terraform
    hclfmt
    nodejs_latest # needed for installing some language servers

    # formatting / linting
    nodePackages.prettier
    alejandra # nix formatting
    statix # nix linter

    # k8s stuff
    kubernetes-helm
    istioctl
    kubectl
    argocd
    cmctl
    kind
    k9s

    # work
    websocat
    (google-cloud-sdk.withExtraComponents [google-cloud-sdk.components.gke-gcloud-auth-plugin])
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

  home.file.".config/wezterm".source = ./wezterm;

  home.file.".config/yamlfmt/.yamlfmt".text = ''
    formatter:
      type: basic
      retain_line_breaks: true
  '';

  nixpkgs.config = {
    allowUnfree = true;
  };

  programs.home-manager.enable = true;
  home.stateVersion = "23.05"; # Don't change this
}
