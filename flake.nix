{
  description = "Home Manager configuration of tomas";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nix-darwin = {
      url = "github:LnL7/nix-darwin";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # Oh My Pi, pinned to an exact revision; update deliberately via
    # `nix flake update omp` after reviewing upstream release notes.
    omp.url = "github:can1357/oh-my-pi/898b09d32f147887a2242cf5ec9a1967bcac8873";
  };

  outputs = {
    nixpkgs,
    home-manager,
    nix-darwin,
    omp,
    ...
  }: let
    # Common user and system settings
    user = "tomas";
    macSystem = "aarch64-darwin";
    macHome = "/Users/tomas";
    linuxSystem = "x86_64-linux";
    linuxHome = "/home/tomas";

    # Shared home-manager module generator
    mkHomeModule = {
      username,
      homeDirectory,
      extraModules ? [],
    }: {
      home = {
        inherit username homeDirectory;
        stateVersion = "25.05";
      };
      imports = [./home.nix] ++ extraModules;
    };

    # Helper to build a standalone home-manager configuration
    mkHome = {
      system,
      username,
      homeDirectory,
      fontSize,
    }:
      home-manager.lib.homeManagerConfiguration {
        pkgs = import nixpkgs {inherit system;};
        extraSpecialArgs = {inherit fontSize;};
        modules = [(mkHomeModule {inherit username homeDirectory;})];
      };
  in {
    homeConfigurations = {
      linux = mkHome {
        system = linuxSystem;
        username = user;
        homeDirectory = linuxHome;
        fontSize = 11;
      };
    };

    darwinConfigurations = {
      macbook = nix-darwin.lib.darwinSystem {
        system = macSystem;
        modules = [
          home-manager.darwinModules.home-manager
          {
            users.users."${user}" = {
              name = user;
              home = macHome;
            };

            # darwin/omp.nix receives the pinned omp flake input.
            _module.args.omp = omp;

            home-manager = {
              useUserPackages = true;
              # omp is a Mac-only addition for now; the Linux target must keep
              # building without it, so it is only passed to this host.
              extraSpecialArgs = {
                fontSize = 14;
                inherit omp;
              };
              users."${user}" = mkHomeModule {
                username = user;
                homeDirectory = macHome;
                # OpenCode/OpenChamber agent config is Mac-only.
                extraModules = [./agents.nix ./omp.nix];
              };
            };
          }
          ./darwin/macos.nix
        ];
      };
    };
  };
}
