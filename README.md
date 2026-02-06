# home-manager

Nix flake repo for my local developer environment (shell, terminal, editor, git, tmux, and agent tooling).

## Flake outputs

- macOS (nix-darwin + Home Manager): `darwinConfigurations.macbook`
- Linux (Home Manager): `homeConfigurations.linux`

## Setup

### 1) Install Nix

```bash
curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install
```

### 2) If this is a new machine, set up GitHub SSH auth

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -C "<key description>"
cat ~/.ssh/id_ed25519.pub
# add key to GitHub
```

### 3) Clone this repo

```bash
git clone git@github.com:tomasmota/home-manager.git ~/.config/home-manager
cd ~/.config/home-manager
```

### 4) Apply configuration

- Bootstrap (nothing installed yet)
  - Linux: `nix run home-manager/master -- switch --flake .#linux`
  - macOS: `nix run nix-darwin/master#darwin-rebuild -- switch --flake .#macbook`

- After bootstrap (daily use)
  - Linux: use `hms`
  - macOS: use `nds`

### 5) (Optional) Ensure zsh is login shell

```bash
echo ~/.nix-profile/bin/zsh | sudo tee -a /etc/shells
chsh -s $(which zsh)
```

## Validate / build without switching

```bash
nix flake show
nix flake check
home-manager build --flake .#linux
darwin-rebuild build --flake .#macbook
```

## Update dependencies

```bash
nix flake update
```

## Local secrets

- Put local secrets in `secrets.env` at repo root.
- `shell/zsh.nix` sources this file if it exists.
- Never commit credentials.

## Optional work git config + signing

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_work -C "<key description>"
cat ~/.ssh/id_ed25519_work.pub
# add key to work Git host as auth + signing key

mkdir -p ~/dev/work

cat <<'EOF' > ~/dev/work/.gitconfig
[user]
    name = Tomás Mota
    email = <work_email>
    signingkey = ~/.ssh/id_ed25519_work.pub

[core]
    sshCommand = ssh -i ~/.ssh/id_ed25519_work

[gpg "ssh"]
    allowedSignersFile = ~/dev/work/allowed_signers
EOF
```

## Notes

- Aliases and git includes assume repos usually live under `~/dev/work` and `~/dev/personal`.
