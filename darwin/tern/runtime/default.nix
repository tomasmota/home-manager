{
  pkgs,
  home,
}: let
  version = "0.7.2";
  sha256 = "0a3e9ffef15c54202d5c1a5e45d1db0d7ba9d732242f0fea26bebce5cb44c7bd";
  appName = "Tern.app";
  bundleId = "so.stencil.tern";
  cliPath = "Contents/MacOS/tern";
  revision = builtins.hashString "sha256" (builtins.readFile ./install.sh);
  directory = "${home}/.local/share/tern-runtime/${version}-${sha256}-${revision}";
  app = "${directory}/${appName}";
  binary = "${app}/${cliPath}";
  # This is a string, not a Nix path: the authenticated download stays private
  # and is neither fetched nor copied into the Nix store during evaluation.
  dmg = "${home}/.cache/tern/Tern-${version}-macos-arm64.dmg";
  tern = pkgs.writeShellScriptBin "tern" ''
    exec "${binary}" "$@"
  '';
in {
  inherit version sha256 revision directory app binary dmg tern;
  install = ''
    export PATH="${pkgs.coreutils}/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
    ${pkgs.bash}/bin/bash ${./install.sh} ${pkgs.lib.escapeShellArgs [home dmg sha256 appName bundleId version cliPath]}
  '';
}
