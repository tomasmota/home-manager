{
  pkgs,
  config,
  ...
}: {
  programs.git = {
    enable = true;
    difftastic.enable = true;
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

  # This script runs after all files have been written
  # it creates allowed_signers files for both personal and work git configuration
  home.activation.setupGitSigners = config.lib.dag.entryAfter ["writeBoundary"] ''
    if [ -f "${config.home.homeDirectory}/.ssh/id_ed25519.pub" ]; then
      echo "* $(cat ${config.home.homeDirectory}/.ssh/id_ed25519.pub)" > ${config.home.homeDirectory}/.ssh/allowed_signers
    else
      echo "Warning: SSH public key not found at ${config.home.homeDirectory}/.ssh/id_ed25519.pub"
    fi

    if [ -f "${config.home.homeDirectory}/.ssh/id_ed25519_work.pub" ]; then
      echo "* $(cat ${config.home.homeDirectory}/.ssh/id_ed25519_work.pub)" > ${config.home.homeDirectory}/dev/work/allowed_signers
    fi
  '';
}
