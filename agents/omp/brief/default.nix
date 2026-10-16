# `brief` CLI and its zsh completion. ../default.nix loads the omp extension
# (brief.ts) through `policy.extensions`, like the other extensions.
{pkgs, ...}: {
  home.packages = [
    (pkgs.writeShellApplication {
      name = "brief";
      runtimeInputs = [pkgs.coreutils pkgs.fzf];
      text = builtins.readFile ./brief.sh;
    })
    (pkgs.writeTextDir "share/zsh/site-functions/_brief" (builtins.readFile ./_brief))
  ];
}
