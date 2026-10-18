# Managed omp extensions and MCP servers, shared by default.nix (which installs
# them) and darwin/tern.nix (whose tern-omp-status compares installed files to
# these declarations). `source` is the checkout-relative path and `sha256` its
# content at build time, so status can tell when the checkout moved on.
{lib}: let
  # Directory interpolation alone does not check that imported modules exist.
  # Fail during evaluation if Git's flake snapshot omits a new runtime file.
  jevDir = assert lib.assertMsg
  (builtins.all (name: builtins.pathExists (./jev + "/${name}")) [
    "jev-client.js"
    "tmux-title.ts"
    "tmux-title-core.js"
    "tmux-status.ts"
    "tmux-status-core.js"
  ])
  "omp: Jev extension modules are missing from the flake source; git add the new modules before rebuilding.";
    ./jev;

  extension = source: file: store: {
    inherit source store;
    sha256 = builtins.hashFile "sha256" file;
  };
in {
  extensions = [
    (extension "agents/omp/guard.ts" ./guard.ts "${./guard.ts}")
    (extension "agents/omp/jev/tmux-title.ts" ./jev/tmux-title.ts "${jevDir}/tmux-title.ts")
    (extension "agents/omp/jev/tmux-status.ts" ./jev/tmux-status.ts "${jevDir}/tmux-status.ts")
    (extension "agents/omp/status-line.ts" ./status-line.ts "${./status-line.ts}")
    (extension "agents/omp/brief/brief.ts" ./brief/brief.ts "${./brief/brief.ts}")
  ];

  mcpFile = ./mcp.json;
  inherit (builtins.fromJSON (builtins.readFile ./mcp.json)) mcpServers;

  # Other checkout files whose edits change what a switch would install.
  inputs = {
    "agents/omp/default.nix" = builtins.hashFile "sha256" ./default.nix;
    "agents/omp/managed.nix" = builtins.hashFile "sha256" ./managed.nix;
    "agents/omp/mcp.json" = builtins.hashFile "sha256" ./mcp.json;
    "agents/omp/jev/jev-client.js" = builtins.hashFile "sha256" ./jev/jev-client.js;
    "agents/omp/jev/tmux-title-core.js" = builtins.hashFile "sha256" ./jev/tmux-title-core.js;
    "agents/omp/jev/tmux-status-core.js" = builtins.hashFile "sha256" ./jev/tmux-status-core.js;
  };
}
