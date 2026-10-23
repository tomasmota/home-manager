# Managed omp extensions and MCP servers, shared by default.nix (which installs
# them) and darwin/tern.nix (whose tern-omp-status compares installed files to
# these declarations). `source` is the checkout-relative path and `sha256` its
# content at build time, so status can tell when the checkout moved on.
let
  extension = source: file: store: {
    inherit source store;
    sha256 = builtins.hashFile "sha256" file;
  };
in {
  extensions = [
    (extension "agents/omp/guard.ts" ./guard.ts "${./guard.ts}")
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
  };
}
