# CLIProxyAPI on macOS

CLIProxyAPI exposes the local Claude subscription gateway only on
`127.0.0.1:8317` for OpenCode. It uses an unofficial Claude OAuth compatibility
path and can carry provider terms-of-service or account-enforcement risk.

## Local state

Home Manager creates these local-only files on the first switch:

- `~/.config/cliproxyapi/client.env` — local client key, mode `0600`.
- `~/.config/cliproxyapi/config.yaml` — rendered secret-bearing config, mode
  `0600`.
- `~/.local/share/cliproxyapi/auth/` — mutable Claude OAuth state, mode `0700`.

None belongs in Git, chat, or a backup copied between machines. Authenticate
each machine independently and revoke the Claude session at Anthropic if a
credential is compromised.

## Authenticate Claude

After `darwin-rebuild switch`, authenticate locally from a trusted terminal:

```sh
cli-proxy-api \
  --config ~/.config/cliproxyapi/config.yaml \
  --claude-login --no-browser --oauth-callback-port 54545
```

Open the printed URL in the local browser. Do not paste the URL, callback, code,
or token data into chat or logs. Then restart OpenCode and select a
`claude-subscription/*` model.

## Operations

```sh
launchctl kickstart -k "gui/${UID}/org.nixos.cliproxyapi"
curl --fail --silent http://127.0.0.1:8317/healthz | jq -e '.status == "ok"'
darwin/cliproxyapi/verify.sh
```

Claude cloak mode stays enabled because it is the compatibility path that uses
subscription limits. It also causes Claude tool names to appear as `mcp__...`
aliases; the global OpenCode instructions explain how agents must use those
names. Do not disable cloak mode as a tooling workaround: it also removes the
identity/system rewrite and can route requests to extra-usage billing.

To rotate the client key, stop the gateway, remove `client.env`, apply the
configuration again, then restart CLIProxyAPI, OpenChamber, and the OpenCode
service. Reauthenticate only if the OAuth token is rejected.

## Upgrade

The gateway is pinned at version `7.3.19`. Before changing it, review upstream
release notes and `config.example.yaml` for schema changes, update the version,
archive hash, and extracted-binary hash together in `cliproxyapi.nix`, apply,
and run the verifier. Never use the management panel or an unpinned updater.
