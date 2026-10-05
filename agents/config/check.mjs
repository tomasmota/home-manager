#!/usr/bin/env node
// Offline activation/recovery gate; never reads credentials or fetches sources.
import { readFile, lstat, readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const require = (ok, message) => { if (!ok) throw new Error(message) }
const packages = ["agent-routes", "auto-retitle", "auto-approve-jev", "stuck-command", "tmux-title-jev", "gcloud-auth-healer", "auto-handoff"]
const skills = { hey: ["SKILL.md"], "typesafe-ai": ["LICENSE", "SKILL.md"], handoff: ["SKILL.md"], "model-selector": ["SKILL.md", "scripts/select.mjs"], "use-uvx": ["SKILL.md"], "model-benchmarks": ["SKILL.md", "scripts/aa.mjs"] }
export async function check(root) {
  const safe = async (path) => {
    require(typeof path === "string" && !/[\\\0]/.test(path) && path.split("/").every((p) => p && p !== "." && p !== ".."), "unsafe snapshot path")
    let current = root
    require(!(await lstat(current)).isSymbolicLink(), "symlink snapshot root")
    for (const part of path.split("/")) { current = join(current, part); require(!(await lstat(current)).isSymbolicLink(), "symlink snapshot path") }
    return current
  }
  const json = async (p) => JSON.parse(await readFile(await safe(p), "utf8"))
  const lock = await json("agents/config/lock.json")
  require(lock.schemaVersion === 1 && lock.pluginApi === "2.0" && ["2.0.16", "2.0.22"].includes(lock.opencode) && /^[a-f0-9]{40}$/.test(lock.revision), "unsupported central lock")
  for (const name of ["mac"]) {
    const inventory = await json(`agents/config/inventory.${name}.json`)
    const adapter = await json(`agents/config/${name}.json`)
    const out = adapter.outputs
    require(inventory.schemaVersion === 1 && inventory.profile === name && equal(inventory.central, lock), "snapshot identity mismatch")
    require(inventory.server === out.server && equal(inventory.packages.map((p) => p.id), packages) && inventory.packages.every((p) => p.path === `opencode/plugins/${p.id}`), "package coverage mismatch")
    require(equal(Object.keys(inventory.skills).sort(), Object.keys(skills).sort()), "skill coverage mismatch")
    const expectedInputs = [adapter.server, adapter.instructions, adapter.cli].sort()
    require(equal(Object.keys(inventory.inputs.files).sort(), expectedInputs) && inventory.inputs.adapter === hash(JSON.stringify(adapter, null, 2) + "\n"), "input coverage or adapter mismatch")
    const artifacts = [out.server, out.instructions, out.routes, out.cli, out.inventoryTool, ...["agent-routes.js", "jev-client.js", "quota-cache.js"].map((p) => `${out.helpers}/${p}`)]
    artifacts.push(...["permission-review.js", "jev-client.js", "decision-audit.js"].map((p) => `${out.helpers}/permission-review/${p}`))
    for (const [id, files] of Object.entries(skills)) {
      require(equal(Object.keys(inventory.skills[id].files).sort(), [...files].sort()), "skill file coverage mismatch")
      artifacts.push(...files.map((p) => `${out.skills}/${id}/${p}`))
      const walk = async (dir, prefix = "") => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async (entry) => entry.isDirectory() ? walk(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]))).flat()
      const present = (await walk(await safe(`${out.skills}/${id}`))).filter((p) => !(id === "hey" && [".installed-version", ".managed-by-hey-cli"].includes(p)))
      require(equal(present.sort(), [...files].sort()), "unexpected portable skill files")
    }
    require(equal(Object.keys(inventory.artifacts).sort(), artifacts.sort()), "artifact coverage mismatch")
    for (const [path, expected] of Object.entries({ ...inventory.inputs.files, ...inventory.artifacts })) require(hash(await readFile(await safe(path))) === expected, "stale snapshot bytes")
    const base = await json(adapter.server), config = await json(out.server), routes = await json(out.routes)
    for (const [key, value] of Object.entries(base)) if (key !== "agents") require(equal(config[key], value), "platform adapter drift")
    require(equal(config.plugins.map((p) => typeof p === "string" ? p : p.package), packages.map((id) => `git+ssh://git@github.com/tomasmota/agents.git#${lock.revision}::path:opencode/plugins/${id}`)), "package pin drift")
    require(equal(config.permissions, base.permissions) && config.experimental.subagent_depth === 2 && config.websearch.provider === "exa" && equal(config.tool_output, { max_lines: 500, max_bytes: 16000 }) && equal(config.compaction, { auto: true, keep: { tokens: 12000 } }), "portable settings drift")
    for (const [id, selection] of Object.entries(adapter.models)) {
      require(config.agents[id].model === selection.model && config.agents[id].mode === selection.mode && routes.agents[id].model === selection.model, "role selection drift")
    }
  }
  const runtime = await json("agents/runtime/package.json"), runtimeLock = await json("agents/runtime/package-lock.json")
  require(equal(runtime.dependencies, { "@openchamber/web": "2.0.0", "@opencode/cli": lock.opencode }) && equal(runtimeLock.packages[""].dependencies, runtime.dependencies), "runtime pin drift")
  require(equal(runtime.allowScripts, { [`@opencode/cli@${lock.opencode}`]: true, "node-pty@1.2.0-beta.15": true, "msgpackr-extract@3.0.4": true }), "runtime script allowlist drift")
  for (const [id, version] of Object.entries(runtime.dependencies)) require(runtimeLock.packages[`node_modules/${id}`].version === version, "runtime lock drift")
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await check(resolve(process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)))); console.log("agent configuration: offline snapshots, adapters and runtime pins match") }
  catch { console.error("agent configuration: offline conformance failed; check lock, adapters, inventory coverage and snapshot bytes"); process.exitCode = 1 }
}
