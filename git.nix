{
  pkgs,
  config,
  ...
}: {
  home.file.".ssh/allowed_signers".text = ''
    * ${builtins.readFile "${config.home.homeDirectory}/.ssh/id_ed25519.pub"}
  '';

  programs.git = {
    enable = true;
    difftastic.enable = true;
    package = pkgs.gitFull;
    userEmail = "tomasmota@hey.com";
    userName = "tomasmota";
    extraConfig = {
      init.defaultBranch = "main";
      push.autoSetupRemote = true;

      # Git branch UI
      branch.sort = "-committerdate";
      column.ui = "auto";

      # Makes stuff faster
      maintenance.strategy = "incremental";

      core.sshCommand = "ssh -i ${config.home.homeDirectory}/.ssh/id_ed25519";

      # Sign all commits using ssh key
      commit.gpgsign = true;
      gpg.format = "ssh";
      user.signingkey = "${config.home.homeDirectory}/.ssh/id_ed25519.pub";
      gpg.ssh.allowedSignersFile = "${config.home.homeDirectory}/.ssh/allowed_signers";
    };
    includes = [
      {
        # For work repos, use custom config
        condition = "gitdir:${config.home.homeDirectory}/dev/work/";
        path = "${config.home.homeDirectory}/dev/work/.gitconfig";
      }
    ];
    ignores = ["/.direnv"];
  };
}
