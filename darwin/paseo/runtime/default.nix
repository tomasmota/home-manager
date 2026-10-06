{
  pkgs,
  home,
}: let
  revision = builtins.hashString "sha256" (builtins.readFile ./package.json + builtins.readFile ./package-lock.json);
  directory = "${home}/.local/share/paseo-runtime/${revision}";
  binary = "${directory}/node_modules/.bin/paseo";
  # bin/paseo is `#!/usr/bin/env -S node`, so the locked Node must lead PATH.
  paseo = pkgs.writeShellScriptBin "paseo" ''
    export PATH="${pkgs.nodejs_24}/bin:$PATH"
    exec "${binary}" "$@"
  '';
in {
  inherit revision directory binary paseo;
  install = ''
    export PATH="${pkgs.nodejs_24}/bin:${pkgs.coreutils}/bin:$PATH"
    ${pkgs.bash}/bin/bash ${./install.sh} ${./.} "${directory}" "${revision}"
  '';
}
