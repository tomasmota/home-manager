import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, writeFile, mkdir, cp, rm, symlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { check } from "../check.mjs"
const source = resolve(".")
async function fixture(t) {
  const root = await mkdtemp("/tmp/opencode/home-config-test-")
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = new Set(["agents/config/lock.json", "agents/config/mac.json", "agents/config/linux.json", "agents/runtime/package.json", "agents/runtime/package-lock.json"])
  for (const name of ["mac", "linux"]) {
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
