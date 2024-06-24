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

  home.packages = with pkgs; [
    fh
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
    gcc
    glow
    unzip
    tree
    findutils
    bat
    tree-sitter
    xclip
    neovim
    cloudfoundry-cli

    # code
    go_1_22
    gotools
    cargo
    terraform
    terragrunt
    vault

    # formatting / linting
    nodePackages.prettier
    alejandra # nix formatting
    statix # nix linter

    # k8s stuff
    kubernetes-helm
    kubevela
    kubectl
    kind
    k9s

    # llms
    ollama

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

  home.file.".config/alacritty".source = ./alacritty;

  home.file.".config/yamlfmt/.yamlfmt".text = ''
    formatter:
      type: basic
      retain_line_breaks: true
  '';

  programs.home-manager.enable = true;
  home.stateVersion = "23.05"; # Don't change this
}
