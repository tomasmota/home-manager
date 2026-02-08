{config}: {
  # home-manager
  hm = "home-manager";
  hmcd = "cd ${config.xdg.configHome}/home-manager";
  hme = "pushd ${config.xdg.configHome}/home-manager && nvim . && home-manager switch --impure && popd";

  # nix-darwin
  nds = "sudo darwin-rebuild switch --flake .#";

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
  ks = ''kubectl config get-contexts -o name | fzf | xargs -I {} sh -c "kubectl config use-context {}; kubectl version > /dev/null 2>&1 &"'';
  kc = ''kubectl config current-context'';
  kn = ''kubectl get ns --no-headers | awk '{print $1}' | fzf | xargs -I {} kubectl config set-context --current --namespace "{}"'';
  knettool = ''kubectl run --rm  -it --image wbitt/network-multitool tmp-debug -- /bin/bash'';
  oc = ''opencode'';

  # Git
  g = "git";
  gsw = "git switch";
  gst = "git status";
  ga = "git add";
  gaa = "git add --all";
  gd = "git diff";
  gc = "git commit --message";
  gp = "git push";
  gpt = "git push --tags";
  gpmr = "git push -o merge_request.create";
  gl = "git pull";
  gld = "git log -p --oneline --ext-diff";
  gD = "git diff HEAD~1";
  # interactively browse commits, opening them in Diffview on select
  gdi = ''git log --oneline | fzf --preview 'git show --name-only {1}' --bind "enter:execute(nvim -c 'DiffviewOpen {1}^!' -- . ':(exclude)flake.lock' ':(exclude)nvim/lazy-lock.json' '(exclude)yarn.lock')"'';
  # diff between HEAD and the main branch
  gdm = ''nvim -c "DiffviewOpen $(git_main_branch)..."'';
  # clean up branches that have also been deleted in remote
  gprune = ''read -q "REPLY?Delete local branches (except main/master)? [y/N] " && git remote prune origin && git for-each-ref --format "%(refname:short)" refs/heads | grep -v "master\|main" | xargs -I {} git branch -d "{}"; echo'';
  gbd = "git branch --delete";
  gswm = "git switch main";
  gswc = "git switch --create";
  grhh = ''read -q "REPLY?Reset hard and discard local changes? [y/N] " && git reset --hard; echo'';
  cdg = "cd $(git rev-parse --show-toplevel)";

  # Docker
  dprune = ''read -q "REPLY?Prune all Docker images? [y/N] " && docker image prune --all; echo'';

  # tofu
  tfi = "tofu init";
  tfp = "tofu plan --parallelism=30";
  tfa = "tofu apply --parallelism=30";
  tfd = "tofu destroy";
  tfs = "tofu show";
  tfv = "tofu validate";
  tfu = "tofu force-unlock $(tofu plan 2>&1 | grep ID | awk '{print $4}')";

  # Files
  # Fuzzy find tree and cd into folder
  cdf = ''cd $(fd --type directory | fzf --preview "tree -I \"node_modules|dist|coverage\" -C {}")'';
  # Fuzzy find over all repos under ~/dev
  cdr = ''    cd "$(fd --search-path ~/dev -d 7 -t d --hidden --no-ignore-vcs "^\.git$" \
                    | xargs dirname \
                    | fzf --preview "tree -I \"node_modules|dist|coverage\" -C {}")" \
            && [[ -n $TMUX ]] \
            && tmux rename-window "''${PWD##*/}"'';
  # Fuzzy find tree and open folder in neovim
  nvd = ''nv $(fd --type directory | fzf --preview "tree -I \"node_modules|dist|coverage\" -C {}")'';
  cdt = ''    cd "$(git rev-parse --show-toplevel)" && cd "$(fd --type f --hidden --glob ".terraform.lock.hcl" \
                 | xargs -n1 dirname \
                 | fzf --preview "tree -I \"node_modules|.terraform|.git|dist|coverage\" -C {}")"
  '';
}
