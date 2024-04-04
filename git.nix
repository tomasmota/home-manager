{
  pkgs,
  home,
}: {
  home.file.".ssh/allowed_signers".text = ''
    * ${builtins.readFile "${home.homeDirectory}/.ssh/id_ed25519.pub"}
  '';

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

      core.sshCommand = "ssh -i ~/.ssh/id_ed25519";

      # Sign all commits using ssh key
      commit.gpgsign = true;
      gpg.format = "ssh";
      user.signingkey = "${home.homeDirectory}/.ssh/id_ed25519.pub";
      gpg.ssh.allowedSignersFile = "${home.homeDirectory}/.ssh/allowed_signers";
    };
    includes = [
      {
        # For work repos, use custom config
        condition = "gitdir:${home.homeDirectory}/dev/work/";
        path = "${home.homeDirectory}/dev/work/.gitconfig";
      }
    ];
    ignores = ["/.direnv"];
  };
}
