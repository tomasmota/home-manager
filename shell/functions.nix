{config}: ''
  # delete a tag from local and origin
  function delete_tag(){
      git tag -d $1
      git push --delete origin $1
  }

  # open files based on ripgrep search
  function nvg(){
      file=$(rg -S $1 -l | fzf --preview "bat --color=always {}")
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

  # sync dotfiles
  function hmsync(){
      cd ${config.xdg.configHome}/home-manager
      git pull
      home-manager switch --impure
      cd -
  }
''
