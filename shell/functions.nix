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

    # home-manager switch
    hms() {
    if [ $# -eq 0 ]; then
        if [[ "$(uname)" == "Darwin" ]]; then
            home-manager switch --flake .#mac
        else
            home-manager switch --flake .#linux
        fi
    else
        home-manager switch --flake .#$1
    fi
    }

    # sync dotfiles
    function hmsync(){
        cd ${config.xdg.configHome}/home-manager
        git pull
        hms
        cd -
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

    gacp() {
        if [ -z "$1" ]; then
            echo "Error: Please provide a commit message"
            echo "Usage: gacp \"commit message\""
            return 1
        fi
        git add .
        git commit -m "$1"
        git push
    }

    ziprepo() {
        top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "Not in a git repo."; return 1; }
        if [ -n "$1" ]; then name="$1"; else name=$(basename "$top"); fi
        tmpdir=$(mktemp -d)

        git -C "$top" archive --format=zip --prefix="$name/" -o "$tmpdir/$name.zip" HEAD || { echo "git archive failed"; return 1; }

        if [ "$(uname)" = "Darwin" ]; then
            open "$tmpdir"
        else
            xdg-open "$tmpdir" >/dev/null 2>&1 || echo "$tmpdir"
        fi
    }
''
