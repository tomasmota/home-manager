# home-manager

## Setup

### Make sure nix is installed
`curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install`


### If this is a new machine, set up github authentication
```bash
ssh-keygen -t ed25519 -C "mail@example.com"
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub
*add key to github*
```

### Clone this repo into .config
`git clone git@github.com:tomasmota/home-manager.git ~/.config/home-manager`

### Init home-manager
`nix run home-manager/master -- init --switch`

### Set zsh as shell
`echo ~/.nix-profile/bin/zsh | sudo tee -a /etc/shells`

`chsh -s $(which zsh)`  

### Set up work .gitconfig and signing (OPTIONAL)
```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_work

mkdir -p ~/dev/work

cat << EOF > ~/dev/work/.gitconfig
[user]
    name = Tomás Mota
    email = <work_email>
    signingkey = "~/.ssh/id_ed25519_work.pub"

[gpg "ssh"]
    allowedSignersFile = "/home/tomas/dev/work/allowed_signers"
EOF

echo "* $(cat ~/.ssh/id_ed25519_work.pub)" > ~/dev/work/allowed_signers

eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519_work

*Add pub key to work git as both auth and signing key*
```

## Notes

Existing aliases and git config assume all code is under ~/dev/work/ and ~/dev/personal/

## Add secrets to secrets.env, at the root of this repo

## TODO:
- fix auto commit message
- add fonts to repo

try plugins
- vim-fugitive
- markdown preview 
