#!/usr/bin/env bash
# omp installation checks: services, config, symlinks, approval mode.
# Never prints tokens; reads only health endpoints and non-secret config.
set -euo pipefail

readonly CHECKOUT="${HOME}/.config/home-manager"
readonly AGENT_DIR="${HOME}/.omp/agent"
readonly BROKER_URL=http://127.0.0.1:8765
readonly GATEWAY_URL=http://127.0.0.1:4000

command -v omp >/dev/null
test "$(omp --version | wc -l)" -ge 1

# Config file must be a writable copy (omp locks and rewrites it), not a link.
test -f "${AGENT_DIR}/config.yml"
test ! -L "${AGENT_DIR}/config.yml"
test "$(stat -f '%OLp' "${AGENT_DIR}/config.yml")" = 600

# Repo-tracked inputs are out-of-store symlinks into the checkout.
for f in RULES.md agents; do
  test -L "${AGENT_DIR}/${f}"
  test "$(realpath "${AGENT_DIR}/${f}")" = "$(realpath "${CHECKOUT}/agents/omp/${f}")"
done
test -f "${AGENT_DIR}/mcp.json"
test ! -L "${AGENT_DIR}/mcp.json"
test "$(stat -f '%OLp' "${AGENT_DIR}/mcp.json")" = 600
test -f "${AGENT_DIR}/agents/coder.md"
test -f "${AGENT_DIR}/agents/terminal.md"
test -f "${AGENT_DIR}/agents/deep.md"

# Nix policy keys survived omp's runtime rewrites since the last switch.
grep --quiet --fixed-strings 'approvalMode: yolo' "${AGENT_DIR}/config.yml"
grep --quiet --fixed-strings 'url: http://127.0.0.1:8765' "${AGENT_DIR}/config.yml"
omp config get tools.approvalMode --json | jq -e '.value == "yolo"' >/dev/null
omp config get tools.approval --json | jq -e '[.value[] | select(. != "allow")] == []' >/dev/null
omp config get extensionHandlers.toolCallTimeoutMs --json | jq -e '.value >= 150000' >/dev/null
omp config get advisor.enabled --json | jq -e '.value == false' >/dev/null
omp config get modelRoles --json | jq -e '.value.judge == "typesafe/jev-latest"' >/dev/null

# Inco custom provider: read-only models.yml, literal smol id resolvable.
# Lists the catalog only; the credential command is not executed here.
test -f "${AGENT_DIR}/models.yml"
# Roles are runtime-owned (seeded only), so require presence, not a value.
omp config get modelRoles --json | jq -e '.value.default and .value.smol' >/dev/null
omp models inco --json | jq -e 'any(.models[]; .selector == "inco/glm-5.3-flash:fast")' >/dev/null

# Judge role: jev-latest is a judge-kind model (omp models defaults to
# --kind chat) and is listed only when the typesafe credential resolves, so
# this fails until `omp auth-broker login typesafe` (or the shell key) works.
omp models typesafe --kind judge --json | jq -e 'any(.models[]; .id == "jev-latest")' >/dev/null
omp config get features.unexpectedStopDetection --json | jq -e '.value == "smart"' >/dev/null
omp config get retry.fallbackChains --json | jq -e '.value.judge == [] and .value.smol == []' >/dev/null

# Exercise the shipped immutable policy factory, not just the checkout source.
# Live parent/child denial probes are still required before delegated MCP use.
policy="$(omp config get extensions --json | jq -er '.value[] | select(endswith("-mcp-policy.ts"))')"
test -r "$policy"
reviewer="$(omp config get extensions --json | jq -er '.value[] | select(endswith("/auto-approve-jev.ts"))')"
test -r "$reviewer"
OPENCODE_JEV_DEBUG=0 node --input-type=module - "$policy" "$reviewer" <<'JS'
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const { default: policy } = await import(pathToFileURL(process.argv[2]));
let toolCall;
policy({ on(name, handler) { assert.equal(name, "tool_call"); toolCall = handler; } });
for (const toolName of ["mcp__confluence_deletepage", "mcp__chrome_devtools_performance_new_tool"]) {
  assert.equal(toolCall({ toolName }).block, true);
}
assert.equal(toolCall({ toolName: "mcp__confluence_getjiraissue" }), undefined);
const { default: reviewer } = await import(pathToFileURL(process.argv[3]));
let review;
reviewer({ on(name, handler) { assert.equal(name, "tool_call"); review = handler; } });
const context = { cwd: process.cwd(), hasUI: false };
assert.equal((await review({ toolName: "bash", input: { command: "rm -rf /" } }, context)).block, true);
assert.equal(await review({ toolName: "read", input: { path: "/" } }, context), undefined);
JS

# Launchd services are loaded and listening on loopback only.
launchctl print "gui/${UID}/org.nixos.omp-auth-broker" >/dev/null
launchctl print "gui/${UID}/org.nixos.omp-auth-gateway" >/dev/null
curl --fail --silent --show-error "${BROKER_URL}/v1/healthz" >/dev/null
curl --fail --silent --show-error "${GATEWAY_URL}/healthz" >/dev/null
test "$(lsof -nP -iTCP:8765 -sTCP:LISTEN -Fn | grep -c '^n127.0.0.1:8765$')" = 1
test "$(lsof -nP -iTCP:4000 -sTCP:LISTEN -Fn | grep -c '^n127.0.0.1:4000$')" = 1

# Token files exist with tight permissions; contents stay unread.
for token in auth-broker auth-gateway; do
  test -f "${HOME}/.omp/${token}.token"
  test "$(stat -f '%OLp' "${HOME}/.omp/${token}.token")" = 600
done

# CLIProxyAPI (OpenCode's, untouched) still healthy on its own port.
curl --fail --silent --show-error http://127.0.0.1:8317/healthz | jq -e '.status == "ok"' >/dev/null

echo "omp: verified"
