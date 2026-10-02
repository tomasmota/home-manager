import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"

const source = resolve("agents/runtime")
const bytes = await Promise.all(["package.json", "package-lock.json"].map((p) => readFile(join(source, p))))
const hash = createHash("sha256").update(bytes[0]).update(bytes[1]).digest("hex")
async function fixture(t) {
  const root = await mkdtemp("/tmp/opencode/runtime test-")
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, "bin")
  await mkdir(bin)
  await writeFile(join(bin, "npm"), `#!/usr/bin/env node
const fs=require('fs'),path=require('path'),args=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,JSON.stringify(args)+'\\n');
if(JSON.stringify(args)===JSON.stringify(['config','get','strict-allow-scripts'])){console.log(process.env.UNSUPPORTED?'undefined':'false');process.exit(0)}
if(args[0]==='ci'&&args[1]==='--prefix'&&args.slice(3).join(' ')==='--strict-allow-scripts --no-audit --no-fund'){
 if(process.env.CI_FAIL)process.exit(1);
 const dir=args[2],bin=path.join(dir,'node_modules/.bin');fs.mkdirSync(bin,{recursive:true});
 for(const [name,version]of [['opencode',process.env.BAD_VERSION?'99.0.0':'2.0.16'],['openchamber','2.0.0']])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\\necho '+version+'\\n',{mode:0o755});
 process.exit(0);
}
if(args[0]==='ls'&&args[1]==='--prefix'&&args[3]==='--depth=0')process.exit(process.env.LS_FAIL?1:0);
throw Error('unexpected mock npm invocation');
`, { mode: 0o755 })
  const destination = join(root, "release with spaces")
  const calls = join(root, "calls")
  const run = (extra = {}, digest = hash) => spawnSync("bash", [join(source, "install.sh"), source, destination, digest], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, ...extra }, timeout: 10000 })
  return { root, destination, calls, run }
}
test("validates stage before publication, reuses a valid immutable runtime and rejects damage", async (t) => {
  const f = await fixture(t)
  assert.equal(f.run().status, 0)
  assert.equal(f.run().status, 0)
  assert.equal((await readFile(f.calls, "utf8")).split("\n").filter((s) => s.startsWith('["ci"')).length, 1)
  assert.ok(!(await readdir(f.root)).some((p) => p.includes("staging") || p.includes("install-lock")))
  await writeFile(join(f.destination, "package.json"), "{}")
  assert.notEqual(f.run().status, 0)
  assert.equal(await readFile(join(f.destination, "package.json"), "utf8"), "{}")
})
test("hash/capability/install/version/tree failures never publish a poisoned runtime", async (t) => {
  for (const failure of [{ hash: true }, { UNSUPPORTED: "1" }, { CI_FAIL: "1" }, { BAD_VERSION: "1" }, { LS_FAIL: "1" }]) {
    const f = await fixture(t)
    assert.notEqual(f.run(failure, failure.hash ? "bad" : hash).status, 0)
    assert.ok(!(await readdir(f.root)).some((p) => p.startsWith("release with spaces")))
    if (failure.hash) await assert.rejects(readFile(f.calls), /ENOENT/)
  }
})
test("symlink destinations and competing publishers are rejected without writes", async (t) => {
  const f = await fixture(t)
  await symlink(f.root, f.destination)
  assert.notEqual(f.run().status, 0)
  await rm(f.destination)
  await mkdir(`${f.destination}.install-lock`)
  assert.notEqual(f.run().status, 0)
  await assert.rejects(readFile(join(f.destination, "package.json")), /ENOENT/)
})
