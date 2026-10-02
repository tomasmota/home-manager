import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, writeFile, cp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
const source = resolve(".")
const central = process.env.AGENTS_SOURCE
const lock = JSON.parse(await readFile(join(source, "agents/config/lock.json")))
const git = (...args) => spawnSync("git", ["-C", central, ...args], { encoding: "utf8" }).stdout.trim()
const ready = central && git("rev-parse", "HEAD") === lock.revision && git("status", "--porcelain", "--untracked-files=normal") === ""
const skip = ready ? false : "set AGENTS_SOURCE to a clean central checkout at the locked revision"
async function fixture(t) {
  const root = await mkdtemp("/tmp/opencode/home-manage-test-")
  t.after(() => rm(root, { recursive: true, force: true }))
  await cp(join(source, "agents"), join(root, "agents"), { recursive: true, filter: (path) => !path.includes("/agents/runtime") })
  return root
}
const manage = (root, mode) => spawnSync("bash", [join(root, "agents/config/manage.sh"), mode], { env: { ...process.env, AGENTS_SOURCE: central }, encoding: "utf8" })
async function snapshot(root, paths) {
  return Promise.all(paths.map((path) => readFile(join(root, path), "utf8")))
}
const watched = ["agents/opencode/opencode.macos.json", "agents/opencode/opencode.json", "agents/opencode/subagents.jsonc", "agents/config/inventory.mac.json", "agents/config/inventory.linux.json", "agents/config/lock.json"]

test("rendering is deterministic for the clean locked source", { skip }, async (t) => {
  const root = await fixture(t)
  assert.equal(manage(root, "--check").status, 0)
  assert.equal(manage(root, "--render").status, 0)
  assert.equal(manage(root, "--check").status, 0)
})

test("a later profile validation failure publishes nothing", { skip }, async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, "agents/opencode/opencode.macos.json"), "fictional stale marker")
  const path = join(root, "agents/config/linux.json")
  const adapter = JSON.parse(await readFile(path))
  adapter.models.explore.model = "claude-subscription/claude-opus-5-5"
  await writeFile(path, JSON.stringify(adapter, null, 2) + "\n")
  const before = await snapshot(root, watched)
  const result = manage(root, "--render")
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /space-bunny|child|subagent/i)
  assert.deepEqual(await snapshot(root, watched), before)
})

test("an artifact obsolete in both profile inventories is removed once", { skip }, async (t) => {
  const root = await fixture(t)
  const path = "agents/skills/obsolete-test.txt"
  const bytes = "fictional obsolete generated artifact\n"
  await writeFile(join(root, path), bytes)
  const hash = createHash("sha256").update(bytes).digest("hex")
  for (const name of ["mac", "linux"]) {
    const file = join(root, `agents/config/inventory.${name}.json`)
    const inventory = JSON.parse(await readFile(file))
    inventory.artifacts[path] = hash
    await writeFile(file, JSON.stringify(inventory, null, 2) + "\n")
  }
  const check = manage(root, "--check")
  assert.notEqual(check.status, 0)
  assert.match(check.stderr, /obsolete generated artifacts/)
  const render = manage(root, "--render")
  assert.equal(render.status, 0, render.stderr)
  await assert.rejects(readFile(join(root, path)), /ENOENT/)
  assert.equal(manage(root, "--check").status, 0)
})

test("update to the already locked revision is idempotent and refuses a different checkout", { skip }, async (t) => {
  const root = await fixture(t)
  const before = await snapshot(root, watched)
  const update = (revision) => spawnSync("bash", [join(root, "agents/config/manage.sh"), "--update", revision], { env: { ...process.env, AGENTS_SOURCE: central }, encoding: "utf8" })
  assert.equal(update(lock.revision).status, 0)
  assert.deepEqual(await snapshot(root, watched), before)
  assert.notEqual(update("0".repeat(40)).status, 0)
  assert.deepEqual(await snapshot(root, watched), before)
})

test("profiles with conflicting shared outputs are rejected before publication", { skip }, async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, "agents/opencode/opencode.macos.json"), "fictional stale marker")
  const path = join(root, "agents/config/linux.json")
  const adapter = JSON.parse(await readFile(path))
  adapter.models.terminal.model = adapter.models.general.model
  await writeFile(path, JSON.stringify(adapter, null, 2) + "\n")
  const before = await snapshot(root, watched)
  const result = manage(root, "--render")
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /conflicting shared output/)
  assert.deepEqual(await snapshot(root, watched), before)
})
