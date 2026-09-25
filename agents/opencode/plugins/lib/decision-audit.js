import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"

const RETENTION_DAYS = 30

// One file per UTC day: retention never rewrites or truncates an active log.
export async function writeDecisionAudit(basePath, record, now = new Date()) {
  if (!isAbsolute(basePath) || !basePath.endsWith(".jsonl")) {
    throw new Error("Jev audit path must be an absolute .jsonl path")
  }
  const directory = dirname(basePath)
  const prefix = basename(basePath, ".jsonl")
  if (!prefix) throw new Error("Jev audit filename must have a nonempty prefix")
  const day = now.toISOString().slice(0, 10)
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - RETENTION_DAYS + 1))
    .toISOString().slice(0, 10)

  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryInfo = await lstat(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.uid !== process.getuid() || (directoryInfo.mode & 0o077) !== 0) {
    throw new Error("Jev audit directory must be owned by this user and mode 0700")
  }

  const filename = join(directory, `${prefix}-${day}.jsonl`)
  const handle = await open(filename, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
      throw new Error("Jev audit file must be owned by this user and mode 0600")
    }
    await handle.writeFile(`${JSON.stringify({ timestamp: now.toISOString(), ...record })}\n`, "utf8")
  } finally {
    await handle.close()
  }

  // Only prune files made by this logger; leave the earlier decisions.jsonl and
  // other files alone. At most 30 daily files remain after a successful write.
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.name.startsWith(`${prefix}-`) || !entry.name.endsWith(".jsonl")) continue
    const fileDay = entry.name.slice(prefix.length + 1, -".jsonl".length)
    if (/^\d{4}-\d{2}-\d{2}$/.test(fileDay) && fileDay < cutoff) {
      await unlink(join(directory, entry.name))
    }
  }
}
