{
  description = "Home Manager configuration of tomas";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    nixpkgs,
    home-manager,
    ...
  }: {
    homeConfigurations = {
      tomas = let
        user = "tomas";
      in
        home-manager.lib.homeManagerConfiguration {
          pkgs = import nixpkgs {system = "x86_64-linux";};
          modules = [
            {
              home.username = user;
              home.homeDirectory = "/home/${user}";
            }
            ./home.nix
          ];
        };

      "tomas@macbook" = let
        user = "tomas";
      in
        home-manager.lib.homeManagerConfiguration {
          pkgs = import nixpkgs {system = "aarch64-darwin";};
          modules = [
            {
              home.username = user;
              home.homeDirectory = "/Users/${user}";
            }
            ./home.nix
          ];
        };
    };
  };
}
