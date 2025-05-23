{config}: {
  # home-manager
  hm = "home-manager";
  hmcd = "cd ${config.xdg.configHome}/home-manager";
  hme = "pushd ${config.xdg.configHome}/home-manager && nvim . && home-manager switch --impure && popd";

  # Misc
  ls = "eza -G --color auto -a -s type";
  la = "eza -l --color always -a -s type";
  l = "eza -l --color always -a -s type";
  nv = "nvim";
  tree = "tree -I 'node_modules|dist|coverage'";
  t = "tree -I 'node_modules|dist|coverage'";
  dra = "direnv allow";
  devflake = "nix flake init -t 'github:tomasmota/flake-templates#devshell'";
  k = "kubectl";
  ks = ''kubectl config get-contexts -o name | fzf | xargs -I {} kubectl config use-context "{}"'';
  kc = ''kubectl config current-context'';
  kn = ''kubectl get ns --no-headers | awk '{print $1}' | fzf | xargs -I {} kubectl config set-context --current --namespace "{}"'';

  # Git
  gc = "git commit --message";
  gpt = "git push --tags";
  gld = "git log -p --oneline --ext-diff";
  gD = "git diff HEAD~1";
  # interactively browse commits, opening them in Diffview on select
  gdi = ''git log --oneline | fzf --preview 'git show --name-only {1}' --bind "enter:execute(nvim -c 'DiffviewOpen {1}^!' -- . ':(exclude)flake.lock' ':(exclude)nvim/lazy-lock.json' '(exclude)yarn.lock')"'';
  # diff between HEAD and the main branch
  gdm = ''nvim -c "DiffviewOpen $(git_main_branch)..."'';
  # clean up branches that have also been deleted in remote
  gprune = ''git remote prune origin && git for-each-ref --format "%(refname:short)" refs/heads | grep -v "master\|main" | xargs git branch -D'';
  gwtcd = "cd $(git worktree list | grep -v '(bare)' | awk '{print $1}' | fzf)";
  gwtrm = "git worktree remove $(git worktree list | grep -v '(bare)' | awk '{print $1}' | fzf)";

  # Docker
  dprune = "docker image prune --all";

  # Terraform
  tfi = "terraform init";
  tfp = "terraform plan";
  tfa = "terraform apply";
  tfd = "terraform destroy";
  tfs = "terraform show";
  tfv = "terraform validate";

  # Yarn
  yd = "yarn dev";
  yi = "yarn install";
  yf = "yarn prettier --write .";

  # Files
  # Fuzzy find tree and cd into folder
  cdf = ''cd $(fd --type directory | fzf --preview "tree -I \"node_modules|dist|coverage\" -C {}")'';
  # Fuzzy find over all repos under ~/dev
    cdr = ''cd "$(fd --search-path ~/dev -d 7 -t d --hidden --no-ignore-vcs "^\.git$" \
                | xargs dirname \
                | fzf --preview "tree -I \"node_modules|dist|coverage\" -C {}")" \
        && [[ -n $TMUX ]] \
        && tmux rename-window "''${PWD##*/}"'';
  # Fuzzy find tree and open folder in neovim
  nvd = ''nv $(fd --type directory | fzf --preview "tree -I \"node_modules|dist|coverage\" -C {}")'';
}
