{ config, ... }:
{
  programs.zsh = {
    enable = true;
    enableAutosuggestions = true;
    enableCompletion = true;
    syntaxHighlighting.enable = true;
    dotDir = ".config/zsh";
    autocd = true;
    defaultKeymap = "emacs";
    history = {
      path = "${config.xdg.cacheHome}/zsh_history";
      save = 1000000;
      extended = true;
      ignoreDups = true;
      share = true;
      ignorePatterns = [ "l*" ];
    };

    oh-my-zsh = {
      enable = true;
      plugins = [ 
        "git"
      ];
    };

    sessionVariables = {
      XDG_CONFIG_HOME = "${config.xdg.configHome}";
      EDITOR = "nvim";
      MANPAGER = "nvim +Man!";
      SRC_ENDPOINT= "https://sourcegraph.com";
      TF_PLUGIN_CACHE_DIR="${config.home.homeDirectory}/.terraform.d/plugin-cache";
    };

    initExtraBeforeCompInit = ''
      setopt menu_complete
      unsetopt beep

      # ZSH settings (helpful for wsl)
      ZSH_HIGHLIGHT_MAXLENGTH=60
      ZSH_HIGHLIGHT_DIRS_BLACKLIST=(/mnt/c)

      # FZF
      _fzf_compgen_path() {
        fd --hidden --follow --exclude ".git" . "$1"
      }
      _fzf_compgen_dir() {
        fd --type d --hidden --follow --exclude ".git" . "$1"
      }

      # delete a tag from local and origin
      function delete_tag(){
          git tag -d $1
          git push --delete origin $1
      }

      # open files based on ripgrep search
      function nvg(){
          file=$(rg $1 -l | fzf --preview "bat --color=always {}")
          if [[ -n $file ]]; then
              nvim $file -c "/$1"
          fi
      }

      function nvf(){
          file=$(fd --type file $1 | fzf --preview "bat --color=always {}")
          if [[ -n $file ]]; then
              nvim $file
          fi
      }

      function nvfh(){
          file=$(fd --hidden --type file $1 | fzf --preview "bat --color=always {}")
          if [[ -n $file ]]; then
              nvim $file
          fi
      }

      # push dotfiles
      function hmpush(){
          cd ${config.xdg.configHome}/home-manager
          git add .
          git commit -m "$${1:-auto}"
          git push
          cd -
      }

      # sync dotfiles
      function hmsync(){
          cd ${config.xdg.configHome}/home-manager
          git pull
          home-manager switch
          cd -
      }

      function nixrun(){
          nix run nixpkgs#$1
      }

      PATH=$PATH:~/.cargo/bin
    '';

    initExtra = ''
      if [[ -f "${config.xdg.configHome}/home-manager/secrets.env" ]]; then
        source ${config.xdg.configHome}/home-manager/secrets.env
      fi
    '';
  
    shellAliases = {
      # home-manager
      hm = "home-manager";
      hms = "home-manager switch";
      hmcd = "cd ${config.xdg.configHome}/home-manager";
      hme = "pushd ${config.xdg.configHome}/home-manager && nvim . && home-manager switch && popd";

      # nixos
      nos = "sudo nixos-rebuild switch --flake ${config.xdg.configHome}/nixos-config";
      noe = "pushd ${config.xdg.configHome}/nixos-config && nvim . && popd";

      # Misc
      ls = "eza -G --color auto -a -s type";
      la = "eza -l --color always -a -s type";
      l = "eza -l --color always -a -s type";
      nv = "nvim";
      tree = "tree -I 'node_modules|dist|coverage'";
      t = "tree -I 'node_modules|dist|coverage'";
      dra = "direnv allow";
      lg = "fd --type=d --max-depth=1";
      devflake = "nix flake init -t 'github:tomasmota/flake-templates#devshell'";
      k = "kubectl";
      ks = "kubectl config get-contexts -o name | fzf | xargs kubectl config use-context";
      wclip = "/mnt/c/Windows/System32/clip.exe";

      # Git
      gc = "git commit --message";
      gpt = "git push --tags";
      gld = "git log -p --oneline --ext-diff";
      gD = "git diff HEAD~1";
      gprune = ''git remote prune origin && git for-each-ref --format "%(refname:short)" refs/heads | grep -v "master\|main" | xargs git branch -D'';

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
      cdr = ''cd $(fd --search-path ~/dev --type directory --hidden --no-ignore-vcs "^\.git$" | xargs -I {} dirname {} | fzf --preview "tree -I \"node_modules|dist|coverage\" -C {}")''; 
      # Fuzzy find tree and open folder in neovim
      nvd = ''nv $(fd --type directory | fzf --preview "tree -I \"node_modules|dist|coverage\" -C {}")'';
    };
  };

  programs.fzf = {
    enable = true;
    defaultOptions = [ "--layout=reverse" "--height=40" ];
  };

  programs.atuin = {
    enable = true;
    flags = ["--disable-up-arrow"];
    enableZshIntegration = true;
  };

  programs.starship = {
    enable = true;
    enableZshIntegration = true;
    settings = {
      gcloud.disabled = true;
      aws.disabled = true;
      cmd_duration.disabled = true;
      helm.disabled = true;
    };
  };
}
