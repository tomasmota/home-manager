{config, ...}: {
  # `learn` is a personal checkout that runs its own omp extension and prompts.
  # Link its launcher onto PATH so the repo path resolves through the real file.
  home.file.".local/bin/learn".source =
    config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/dev/personal/learn/bin/learn";
}
