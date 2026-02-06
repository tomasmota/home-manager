# home-manager

## Setup

### Make sure nix is installed
`curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install`

### If this is a new machine, set up github authentication
```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -C "<key description>"
cat ~/.ssh/id_ed25519.pub
*add key to github*
```

### Clone this repo into .config
`git clone git@github.com:tomasmota/home-manager.git ~/.config/home-manager`

### Init configuration
- Linux: `nix run home-manager/master -- switch --flake .#linux`
- macOS: `sudo darwin-rebuild switch --flake .#macbook`

### Set zsh as shell
`echo ~/.nix-profile/bin/zsh | sudo tee -a /etc/shells`

`chsh -s $(which zsh)`  

### Set up work .gitconfig and signing (OPTIONAL)
```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_work -C "<key description>"

cat ~/.ssh/id_ed25519_work.pub
*Add pub key to work git as both auth and signing key*

mkdir -p ~/dev/work

cat << EOF > ~/dev/work/.gitconfig
[user]
    name = Tomás Mota
    email = <work_email>
    signingkey = "~/.ssh/id_ed25519_work.pub"

[core]
    sshCommand = "ssh -i ~/.ssh/id_ed25519_work"

[gpg "ssh"]
    allowedSignersFile = "~/dev/work/allowed_signers"
EOF
```

### Updating flake
`nix flake update`

## Notes
Existing aliases and git config assume all code is under ~/dev/work/ and ~/dev/personal/

## Add secrets to secrets.env, at the root of this repo

## TODO:
- fix auto commit message
- add fonts to repo

try plugins
- vim-fugitive
- markdown preview 
