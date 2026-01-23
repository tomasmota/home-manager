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
    ./terminal/ghostty.nix
    ./shell/zsh.nix
    (import ./git.nix {inherit pkgs config;})
    (import ./tmux.nix {inherit pkgs xdg;})
  ];

  fonts.fontconfig.enable = true;

  home.packages = with pkgs; [
    fd # better find
    dua # better du
    duf # better df
    btop # better top
    ripgrep # better grep
    eza # better ls
    bat # better cat
    jq
    navi
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
    atuin
    tree-sitter
    just
    rclone
    neovim
    grpcurl
    step-cli # PKI utils
    presenterm # slides in the terminal
    unixtools.watch
    mtr

    # fonts
    nerd-fonts.geist-mono

    # code
    lua
    go_1_25
    gotools
    protobuf
    cargo
    opentofu
    hclfmt
    nodejs_24 # needed for installing some language servers
    pnpm

    # formatting / linting
    nodePackages.prettier
    alejandra # nix formatting
    statix # nix linter

    # k8s stuff
    kubectl
    kubectl-view-secret
    kubectl-explore
    kubectl-tree
    kubernetes-helm
    istioctl
    argocd
    cmctl
    kind
    k9s
    k6

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

  home.file.".config/yamlfmt/.yamlfmt".text = ''
    formatter:
      type: basic
      retain_line_breaks: true
  '';

  programs.home-manager.enable = true;
}
