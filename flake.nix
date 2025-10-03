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
  };

  outputs = {
    nixpkgs,
    home-manager,
    nix-darwin,
    ...
  }: let
    mkHome = {
      system,
      user,
      homeDir,
    }:
      home-manager.lib.homeManagerConfiguration {
        pkgs = import nixpkgs {inherit system;};
        modules = [
          {
            home = {
              username = user;
              homeDirectory = homeDir;
              stateVersion = "24.05";
            };
          }
          ./home.nix
        ];
      };
  in {
    homeConfigurations = {
      mac = mkHome {
        system = "aarch64-darwin";
        user = "tomas";
        homeDir = "/Users/tomas";
      };

      arch = mkHome {
        system = "x86_64-linux";
        user = "tomas";
        homeDir = "/home/tomas";
      };
    };

    darwinConfigurations = {
      macbook = nix-darwin.lib.darwinSystem {
        system = "aarch64-darwin";
        modules = [
          home-manager.darwinModules.home-manager

          {
            users.users.tomas = {
              name = "tomas";
              home = "/Users/tomas";
            };

            home-manager.useUserPackages = true;

            home-manager.users.tomas = {...}: {
              home = {
                username = "tomas";
                homeDirectory = "/Users/tomas";
                stateVersion = "24.05";
              };
              imports = [./home.nix];
            };
          }

          ./darwin/macos.nix
        ];
      };
    };
  };
}
