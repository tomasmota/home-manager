import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, writeFile, mkdir, cp, rm, symlink, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { check } from "../check.mjs"
const source = resolve(".")
const scratch = join(await realpath(tmpdir()), "opencode")
await mkdir(scratch, { recursive: true })
async function fixture(t) {
  const root = await mkdtemp(join(scratch, "home-config-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = new Set(["agents/config/lock.json", "agents/config/mac.json", "agents/runtime/package.json", "agents/runtime/package-lock.json"])
  for (const name of ["mac"]) {
    const path = `agents/config/inventory.${name}.json`
    const inventory = JSON.parse(await readFile(join(source, path)))
    files.add(path)
    for (const p of Object.keys({ ...inventory.inputs.files, ...inventory.artifacts })) files.add(p)
  }
  for (const path of files) { await mkdir(dirname(join(root, path)), { recursive: true }); await cp(join(source, path), join(root, path)) }
  return root
}
test("offline snapshots work without central checkout and reject stale inputs/helpers/skills/runtime", async (t) => {
  await check(await fixture(t))
  for (const path of ["agents/config/platform.md", "agents/config/cli.json", "agents/opencode/lib/jev-client.js", "agents/skills/hey/SKILL.md", "agents/runtime/package-lock.json"]) {
    const root = await fixture(t)
    await writeFile(join(root, path), "fictional changed bytes")
    await assert.rejects(check(root))
  }
})
test("malformed coverage, profile drift, missing files and symlinks fail closed", async (t) => {
  for (const mutate of [(i) => { i.artifacts = {} }, (i) => { i.inputs.files = {} }, (i) => { i.packages = [] }, (i) => { i.profile = "coder" }]) {
    const root = await fixture(t), path = join(root, "agents/config/inventory.mac.json")
    const inventory = JSON.parse(await readFile(path)); mutate(inventory)
    await writeFile(path, JSON.stringify(inventory))
    await assert.rejects(check(root))
  }
  const root = await fixture(t), path = join(root, "agents/skills/hey/SKILL.md")
  await rm(path); await assert.rejects(check(root))
  await symlink(join(source, "agents/skills/hey/SKILL.md"), path)
  await assert.rejects(check(root), /symlink/)
})
test("unsupported runtime versions and extra lifecycle scripts fail closed", async (t) => {
  const root = await fixture(t), lockPath = join(root, "agents/config/lock.json")
  const lock = JSON.parse(await readFile(lockPath))
  for (const version of ["2.0.17", "2.0.22-beta.1", "v2.0.22", null]) {
    await writeFile(lockPath, JSON.stringify({ ...lock, opencode: version }))
    await assert.rejects(check(root), /unsupported central lock/)
  }
  await writeFile(lockPath, JSON.stringify(lock))
  const runtimePath = join(root, "agents/runtime/package.json")
  const runtime = JSON.parse(await readFile(runtimePath))
  runtime.allowScripts["fictional-extra-package@1.0.0"] = true
  await writeFile(runtimePath, JSON.stringify(runtime))
  await assert.rejects(check(root), /runtime script allowlist drift/)
})
