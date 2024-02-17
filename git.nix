{pkgs,...}: {
  home.file.".ssh/allowed_signers".text =
    "* ${builtins.readFile ~/.ssh/id_ed25519.pub}";

  programs.git = {
    enable = true;
    difftastic.enable = true;
    package = pkgs.gitFull;
    userEmail = "tomasrebelomota@gmail.com";
    userName = "tomasmota";
    extraConfig = {
      init.defaultBranch = "main";
      push.autoSetupRemote = true;

      # Git branch UI
      branch.sort = "-committerdate";
      column.ui = "auto";

      # Makes stuff faster
      maintenance.strategy = "incremental";

      # Sign all commits using ssh key
      commit.gpgsign = true;
      gpg.format = "ssh";
      user.signingkey = "~/.ssh/id_ed25519.pub";
      gpg.ssh.allowedSignersFile = "~/.ssh/allowed_signers";
    };
    ignores = ["/.direnv"];
  };
}
