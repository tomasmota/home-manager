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

    # home-manager switch
    hms() {
    if [ $# -eq 0 ]; then
        if [[ "$(uname)" == "Darwin" ]]; then
            home-manager switch --flake .#mac --impure
        else
            home-manager switch --impure
        fi
    else
        home-manager switch --flake .#$1 --impure
    fi
    }

    gssh() {
    # Select project
    local project=$(gcloud projects list | tail -n +2 | awk '{print $1}' | fzf)

    local instance_zone=$(gcloud compute instances list --project="$project" | fzf)

    local instance=$(echo "$instance_zone" | awk '{print $1}')
    local zone=$(echo "$instance_zone" | awk '{print $2}')

    # SSH into the instance
    gcloud compute ssh "$instance" --zone="$zone" --project="$project"
    }
''
