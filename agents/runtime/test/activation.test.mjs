import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"

// nix-darwin runs userLaunchd before Home Manager's postActivation, so the
// runtime must be validated/installed from an earlier system activation hook.
// The ordering below was audited against this exact pin; re-audit on update.
const auditedNixDarwin = {
  rev: "4cff07de74b50e64bdd68cd4e722ab5b6b35ee48",
  narHash: "sha256-oQFip+v0luP8NIxJzmiW4Wu8bILsbFWom5l0zonl8hQ=",
}
const nixEval = process.env.AGENTS_NIX_EVAL === "1"

function nix(args) {
  const r = spawnSync("nix", args, { encoding: "utf8", maxBuffer: 64 << 20, timeout: nixEval ? 120000 : 30000 })
  return r.status === 0 ? r.stdout : null
}

test("nix-darwin pin is the audited activation order", async () => {
  const lock = JSON.parse(await readFile("flake.lock", "utf8"))
  const locked = lock.nodes[lock.nodes.root.inputs["nix-darwin"]].locked
  assert.deepEqual({ rev: locked.rev, narHash: locked.narHash }, auditedNixDarwin)
})

test("pinned nix-darwin runs extraActivation after the check exit and before launchd", (t) => {
  const src = nix(["eval", "--offline", "--raw", "--expr",
    `(builtins.fetchTree { type = "github"; owner = "LnL7"; repo = "nix-darwin"; rev = "${auditedNixDarwin.rev}"; narHash = "${auditedNixDarwin.narHash}"; }).outPath`])
  if (!src) return t.skip("pinned nix-darwin source not available offline")
  const read = (p) => spawnSync("cat", [`${src}/modules/${p}`], { encoding: "utf8" }).stdout
  const script = read("system/activation-scripts.nix")
  assert.match(script, /^\s*set -e$/m)
  const order = ["checks", "extraActivation", "etc", "launchd", "userLaunchd", "postActivation"]
    .map((name) => script.indexOf(`\${cfg.activationScripts.${name}.text}`))
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), `unexpected order ${order}`)
  // `darwin-rebuild check` exits at the end of `checks`, before extraActivation mutates anything.
  assert.match(read("system/checks.nix"), /checkActivation:-0}" -eq 1 \]\]; then\s+echo "ok" >&2\s+exit 0/)
  // The boot-time activate-system daemon does not run extraActivation.
  assert.doesNotMatch(read("services/activate-system/default.nix"), /extraActivation/)
  // userLaunchd unloads the running agent before loading the replacement.
  assert.match(read("system/launchd.nix"), /launchctl unload ~\$\{user\}\/Library\/LaunchAgents\/\$\{target\}/)
})

test("darwin preflight hook is wired and agent config is Mac-only", async () => {
  const agents = await readFile("agents.nix", "utf8")
  const darwin = await readFile("darwin/cliproxyapi.nix", "utf8")
  const home = await readFile("home.nix", "utf8")
  assert.doesNotMatch(agents, /activation\s*=/)
  assert.doesNotMatch(home, /agents\.nix/)
  assert.match(await readFile("flake.nix", "utf8"), /extraModules = \[\.\/agents\.nix /)
  assert.match(agents, /writeShellScript "agent-activation-preflight" ''\s+set -euo pipefail\s+\$\{checkConfig\}\s+\$\{runtime\.install\}/)
  assert.match(darwin, /system\.activationScripts\.extraActivation\.text = lib\.mkAfter ''/)
  assert.match(darwin, /launchctl asuser "\$\(id -u -- \$\{user\}\)" sudo --user=\$\{user\} --set-home -- \$\{config\.home-manager\.users\.\$\{user\}\.agents\.activationPreflight\}\n/)
})

test("evaluated macbook activation validates before launchd and aborts on failure", { skip: !nixEval && "set AGENTS_NIX_EVAL=1 (about a minute)" }, () => {
  const text = nix(["eval", "--raw", ".#darwinConfigurations.macbook.config.system.activationScripts.script.text"])
  assert.ok(text, "darwin activation evaluation failed")
  const lines = text.split("\n")
  const at = (re) => lines.findIndex((l) => re.test(l))
  const exit = at(/checkActivation:-0/)
  const call = at(/^launchctl asuser .* -- \/nix\/store\/[^ ]+-agent-activation-preflight$/)
  const launchd = at(/setting up user launchd services/)
  const openchamber = at(/reloading user service .*org\.nixos\.openchamber\.plist/)
  const hm = at(/Activating home-manager configuration/)
  assert.ok(at(/^set -e$/) >= 0 && exit >= 0 && call > exit && launchd > call && openchamber > launchd && hm > openchamber,
    JSON.stringify({ exit, call, launchd, openchamber, hm }))
  assert.equal(lines.filter((l) => /agent-activation-preflight/.test(l)).length, 1)
  // Run the exact generated command with launchctl/sudo/id stubbed and a failing preflight.
  // The failure must propagate through the activation script's own `set -e`.
  const stub = `launchctl() { [ "$1" = asuser ] && shift 2 && "$@"; }; sudo() { while [ "$1" != -- ]; do shift; done; shift; [ -n "$1" ] && return 7; }; id() { echo 501; }`
  const r = spawnSync("bash", ["-c", `set -e\nset -o pipefail\n${stub}\n${lines[call]}\necho REACHED_LAUNCHD`], { encoding: "utf8" })
  assert.equal(r.status, 7)
  assert.doesNotMatch(r.stdout, /REACHED_LAUNCHD/)
  // The runtime is installed only by the system preflight, never by Home Manager activation.
  const hmUser = nix(["eval", "--json", ".#darwinConfigurations.macbook.config.home-manager.users.tomas", "--apply",
    `u: { entries = builtins.filter (n: n == "agentConfig" || n == "agentRuntime") (builtins.attrNames u.home.activation); preflight = u.agents.activationPreflight.name; }`])
  assert.deepEqual(JSON.parse(hmUser), { entries: [], preflight: "agent-activation-preflight" })
})

test("standalone Linux Home Manager carries no OpenCode agent config", { skip: !nixEval && "set AGENTS_NIX_EVAL=1" }, () => {
  const out = nix(["eval", "--json", ".#homeConfigurations.linux.config", "--apply",
    `c: { entries = builtins.filter (n: n == "agentConfig" || n == "agentRuntime") (builtins.attrNames c.home.activation); files = builtins.filter (n: builtins.match "(\\\\.config/opencode|\\\\.agents)(/.*)?" n != null) (builtins.attrNames c.home.file); preflight = c ? agents; }`])
  assert.deepEqual(JSON.parse(out), { entries: [], files: [], preflight: false })
})
