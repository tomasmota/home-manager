{
  pkgs,
  home,
}: let
  revision = builtins.hashString "sha256" (builtins.readFile ./package.json + builtins.readFile ./package-lock.json);
  directory = "${home}/.local/share/agent-runtime/${revision}";
  opencode = pkgs.writeShellScriptBin "opencode" ''
    export PATH="${pkgs.nodejs_24}/bin:$PATH"
    exec "${directory}/node_modules/.bin/opencode" "$@"
  '';
in {
  inherit revision directory opencode;
  binary = "${directory}/node_modules/.bin/opencode";
  openchamber = "${directory}/node_modules/@openchamber/web/bin/cli.js";
  install = ''
    export PATH="${pkgs.nodejs_24}/bin:${pkgs.coreutils}/bin:$PATH"
    ${pkgs.bash}/bin/bash ${./install.sh} ${./.} "${directory}" "${revision}"
  '';
}
