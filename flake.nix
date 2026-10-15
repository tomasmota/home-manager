{
  description = "Home Manager configuration of tomas";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    # Pin Atuin 18.21.0 until https://github.com/NixOS/nixpkgs/pull/574333 reaches nixos-unstable.
    atuin-nixpkgs.url = "github:nixos/nixpkgs/151fa4e8ddfdd8dd25d945ad94ed54a13de9f6e4";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nix-darwin = {
      url = "github:LnL7/nix-darwin";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # Follow upstream; flake.lock fixes the revision until the next update.
    omp.url = "github:can1357/oh-my-pi";
  };

  outputs = {
    nixpkgs,
    atuin-nixpkgs,
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

            home-manager = {
              useUserPackages = true;
              # omp is a Mac-only addition; the Linux target must keep
              # building without it, so it is only passed to this host.
              extraSpecialArgs = {
                fontSize = 14;
                inherit omp;
              };
              users."${user}" = mkHomeModule {
                username = user;
                homeDirectory = macHome;
                # Local shared instructions/skills and omp are Mac-only.
                extraModules = [
                  ./agents.nix
                  ./agents/omp
                  {
                    nixpkgs.overlays = [
                      (_final: _prev: {
                        atuin = atuin-nixpkgs.legacyPackages.${macSystem}.atuin;
                      })
                    ];
                  }
                ];
              };
            };
          }
          ./darwin/macos.nix
        ];
      };
    };
  };
}
