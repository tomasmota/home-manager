{
  description = "Home Manager configuration of tomas";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, home-manager, ... }:
  let
    mkHome = { system, user, homeDir }:
      home-manager.lib.homeManagerConfiguration {
        pkgs = import nixpkgs { inherit system; };
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
  in
  {
    homeConfigurations = {
      mac = mkHome {
        system  = "aarch64-darwin";
        user    = "tomas";
        homeDir = "/Users/tomas";
      };

      arch = mkHome {
        system  = "x86_64-linux";
        user    = "tomas";
        homeDir = "/home/tomas";
      };
    };
  };
}

