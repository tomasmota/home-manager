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
    # Common user and system settings
    user = "tomas";
    macSystem = "aarch64-darwin";
    macHome = "/Users/tomas";
    linuxSystem = "x86_64-linux";
    linuxHome = "/home/tomas";

    # Shared home-manager module generator
    mkHomeModule = { username, homeDirectory }: {
      home = {
        inherit username homeDirectory;
        stateVersion = "24.05";
      };
      imports = [ ./home.nix ];
    };

    # Helper to build a standalone home-manager configuration
    mkHome = { system, username, homeDirectory, fontSize }:
      home-manager.lib.homeManagerConfiguration {
        pkgs = import nixpkgs { inherit system; };
        extraSpecialArgs = { inherit fontSize; };
        modules = [ (mkHomeModule { inherit username homeDirectory; }) ];
      };
  in {
    homeConfigurations = {
      mac = mkHome {
        system = macSystem;
        username = user;
        homeDirectory = macHome;
        fontSize = 12;
      };

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

            home-manager.useUserPackages = true;
            home-manager.users."${user}" = mkHomeModule {
              username = user;
              homeDirectory = macHome;
            };
          }
          ./darwin/macos.nix
        ];
      };
    };
  };
}
