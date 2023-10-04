# home-manager

## Setup

Make sure nix is installed
`curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install`

Clone this repo into .config
`git clone git@github.com:tomasmota/home-manager.git .config/home-manager`

Init home-manager
`nix run home-manager/master -- init --switch`

Set zsh as shell
`echo ~/.nix-profile/bin/zsh | sudo tee -a /etc/shells`
`chsh -s (which zsh)`  

## Add secrets to secrets.env, at the root of this repo

## TODO:
- add alacritty config
- use lazy.nvim

