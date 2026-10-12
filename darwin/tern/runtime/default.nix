{
  pkgs,
  home,
}: let
  version = "0.8.2";
  sha256 = "ec249dd7cfb7e195db4e0170c500f49612874cd4cc4afb0dd23edcda25c9500c";
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
