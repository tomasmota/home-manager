{pkgs}: let
  # The user installs and updates this app normally; Nix never touches it.
  app = "/Applications/Tern.app";
  binary = "${app}/Contents/MacOS/tern";
  tern = pkgs.writeShellScriptBin "tern" ''
    exec "${binary}" "$@"
  '';
in {
  inherit app binary tern;
}
