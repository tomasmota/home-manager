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
    self,
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

    # Clean copy of the Git flake source for checks (self is the tracked-only
    # store copy); the filter is defense in depth for secrets and local state.
    inherit (nixpkgs) lib;
    cleanSrc = lib.cleanSourceWith {
      name = "home-manager-source";
      src = lib.cleanSource self;
      filter = path: _type: let
        name = baseNameOf path;
      in
        !(builtins.elem name ["secrets.env" "local.zsh" "node_modules" ".direnv" "__pycache__"]
          || lib.hasSuffix ".pyc" name);
    };

    # Discard string context to force host evaluation without building its closure.
    mkEvalCheck = pkgs: name: drv:
      pkgs.runCommand "eval-${name}" {} ''
        echo ${builtins.unsafeDiscardStringContext drv.drvPath} > $out
      '';

    mkChecks = system: extra: let
      pkgs = nixpkgs.legacyPackages.${system};
    in
      {
        # btw.test.mjs needs the installed Paseo runtime, so it is excluded.
        js-tests =
          pkgs.runCommand "js-tests" {
            nativeBuildInputs =
              [pkgs.nodejs_24 pkgs.findutils pkgs.git]
              ++ lib.optionals pkgs.stdenv.hostPlatform.isDarwin [pkgs.darwin.ps];
            # gateway-test.mjs listens on loopback.
            __darwinAllowLocalNetworking = true;
          } ''
            export HOME="$TMPDIR/home"
            export TMPDIR="$TMPDIR/tmp"
            mkdir -p "$HOME" "$TMPDIR"
            cp -R ${cleanSrc} source
            chmod -R u+w source
            cd source
            find . -type f \( -name '*.test.mjs' -o -path ./darwin/tern/gateway-test.mjs \) \
              -not -path ./darwin/paseo/runtime/btw.test.mjs -print0 | sort -z > "$TMPDIR/tests"
            test -s "$TMPDIR/tests"
            # Integration suites create concurrent subprocesses; don't multiply that load per file.
            xargs -0 node --test --test-concurrency=1 < "$TMPDIR/tests"
            touch $out
          '';
        format = pkgs.runCommand "alejandra-check" {nativeBuildInputs = [pkgs.alejandra];} ''
          alejandra --check ${cleanSrc}
          touch $out
        '';
        lint = pkgs.runCommand "statix-check" {nativeBuildInputs = [pkgs.statix];} ''
          cd ${cleanSrc}
          statix check .
          touch $out
        '';
      }
      // extra pkgs;
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

    formatter = {
      ${linuxSystem} = nixpkgs.legacyPackages.${linuxSystem}.alejandra;
      ${macSystem} = nixpkgs.legacyPackages.${macSystem}.alejandra;
    };

    # Each system evaluates only its own host configuration (no closure build).
    checks = {
      ${linuxSystem} = mkChecks linuxSystem (pkgs: {
        home-linux-eval = mkEvalCheck pkgs "home-linux" self.homeConfigurations.linux.activationPackage;
      });
      ${macSystem} = mkChecks macSystem (pkgs: {
        darwin-macbook-eval = mkEvalCheck pkgs "darwin-macbook" self.darwinConfigurations.macbook.system;
      });
    };
  };
}
