import assert from "node:assert/strict"
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { writeDecisionAudit } from "../plugins/lib/decision-audit.js"

test("keeps full private daily records for 30 UTC dates and prunes only its own older files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-audit-"))
  const basePath = join(directory, "decisions.jsonl")
  const oldLog = join(directory, "decisions.jsonl")
  try {
    await writeFile(oldLog, "legacy log\n")
    await writeDecisionAudit(basePath, { resources: ["old"] }, new Date("2026-08-26T23:59:59Z"))
    await writeDecisionAudit(basePath, { resources: ["boundary"] }, new Date("2026-08-27T00:00:00Z"))
    const command = `bash -c '${"a".repeat(4096)}'`
    await writeDecisionAudit(basePath, { sessionID: "ses_test", action: "shell", resources: [command], decision: "allow", source: "jev" }, new Date("2026-09-25T10:20:30Z"))

    const files = await readdir(directory)
    assert.deepEqual(files.sort(), ["decisions-2026-08-27.jsonl", "decisions-2026-09-25.jsonl", "decisions.jsonl"])
    assert.equal((await lstat(directory)).mode & 0o777, 0o700)
    const today = join(directory, "decisions-2026-09-25.jsonl")
    assert.equal((await lstat(today)).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse((await readFile(today, "utf8")).trim()), {
      timestamp: "2026-09-25T10:20:30.000Z", sessionID: "ses_test", action: "shell",
      resources: [command], decision: "allow", source: "jev",
    })
    assert.equal(await readFile(oldLog, "utf8"), "legacy log\n")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("refuses existing public files and symlinks without writing sensitive commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-audit-"))
  const basePath = join(directory, "decisions.jsonl")
  const filename = join(directory, "decisions-2026-09-25.jsonl")
  const now = new Date("2026-09-25T10:20:30Z")
  try {
    await writeFile(filename, "public\n", { mode: 0o644 })
    await chmod(filename, 0o644) // The service/test process may have umask 0077.
    await assert.rejects(writeDecisionAudit(basePath, { resources: ["sensitive"] }, now), /mode 0600/)
    assert.equal(await readFile(filename, "utf8"), "public\n")
    await rm(filename)
    await symlink(join(directory, "target"), filename)
    await assert.rejects(writeDecisionAudit(basePath, { resources: ["sensitive"] }, now), { code: "ELOOP" })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
