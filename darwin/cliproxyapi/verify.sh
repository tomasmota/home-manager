#!/usr/bin/env bash
set -euo pipefail

readonly VERSION=7.3.19
readonly BINARY_SHA256=2af8429560a91add289d9197b8f769a4325ceb4f8fc43ba0f76cf793eb469504
readonly BINARY=/run/current-system/sw/bin/cli-proxy-api
readonly CONFIG_DIR="${HOME}/.config/cliproxyapi"
readonly CONFIG="${CONFIG_DIR}/config.yaml"
readonly ENV_FILE="${CONFIG_DIR}/client.env"
readonly TEMPLATE="${HOME}/.config/home-manager/darwin/cliproxyapi/config.yaml"
readonly LABEL=org.nixos.cliproxyapi

test "$(uname -m)" = arm64
test -x "${BINARY}"
binary_help=$("${BINARY}" --help 2>&1)
grep --quiet --fixed-strings "CLIProxyAPI Version: ${VERSION}," <<<"${binary_help}"
unset binary_help
test "$(shasum -a 256 "${BINARY}" | awk '{print $1}')" = "${BINARY_SHA256}"
test "$(stat -f '%OLp' "${CONFIG_DIR}" "${CONFIG}" "${ENV_FILE}")" = $'700\n600\n600'
test "$(stat -f '%OLp' "${HOME}/.local/share/cliproxyapi/auth")" = 700
grep --quiet '^host: "127.0.0.1"$' "${CONFIG}"
grep --quiet '^  disable-control-panel: true$' "${CONFIG}"
grep --quiet '^disable-claude-cloak-mode: false$' "${CONFIG}"

client_key=$(sed -nE 's/^export CLIPROXYAPI_API_KEY=([A-Za-z0-9_-]{48,})$/\1/p' "${ENV_FILE}")
test -n "${client_key}"
normalized_config=$(mktemp)
trap 'rm -f "${normalized_config}"; unset client_key' EXIT
sed "s|${client_key}|__CLIPROXYAPI_API_KEY__|g" "${CONFIG}" >"${normalized_config}"
cmp --silent "${TEMPLATE}" "${normalized_config}"

launchctl print "gui/${UID}/${LABEL}" >/dev/null
health=$(curl --fail --silent --show-error http://127.0.0.1:8317/healthz)
test "$(jq -r '.status' <<<"${health}")" = ok
test "$(lsof -nP -iTCP:8317 -sTCP:LISTEN -Fn | grep -c '^n127.0.0.1:8317$')" = 1

set -a
source "${ENV_FILE}"
set +a
models=$(opencode models)
grep --quiet --fixed-strings 'claude-subscription/claude-opus-5-5' <<<"${models}"
grep --quiet --fixed-strings 'claude-subscription/claude-sonnet-5' <<<"${models}"

catalog=$(opencode api get /api/model)
jq --exit-status '.data[]
  | select(.providerID == "claude-subscription" and .id == "claude-opus-5-5")
  | select(.limit.context == 1000000 and .limit.output == 128000)
  | select(.capabilities.input | index("pdf"))
  | select((.variants | map(.id) | sort) == ["high", "low", "max", "medium", "xhigh"])
  | select(.cost[0].input == 0 and .cost[0].output == 0)' <<<"${catalog}" >/dev/null
unset CLIPROXYAPI_API_KEY models catalog

echo "CLIProxyAPI ${VERSION}: verified"
