import { execFile } from "node:child_process"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const contextFileName = ".opencode-worktree-context.md"
const contextIgnorePattern = `/${contextFileName}`

const readIfPresent = async (path) => {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

const runGit = async (cwd, args) => {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  })
  return stdout.trim()
}

const absolutePath = (cwd, path) => (isAbsolute(path) ? resolve(path) : resolve(cwd, path))

const worktreeLocation = async (directory) => {
  try {
    const root = await runGit(directory, ["rev-parse", "--show-toplevel"])
    const gitDir = absolutePath(root, await runGit(root, ["rev-parse", "--absolute-git-dir"]))
    const commonDir = absolutePath(root, await runGit(root, ["rev-parse", "--git-common-dir"]))

    // Main checkouts and submodules use one Git directory; linked worktrees do not.
    if (gitDir === commonDir) return null

    const excludePath = absolutePath(
      root,
      await runGit(root, ["rev-parse", "--git-path", "info/exclude"]),
    )

    return {
      contextPath: resolve(root, contextFileName),
      excludePath,
    }
  } catch {
    return null
  }
}

const ensureIgnored = async (excludePath) => {
  const current = (await readIfPresent(excludePath)) ?? ""
  if (current.split(/\r?\n/).some((line) => line.trim() === contextIgnorePattern)) return

  await mkdir(dirname(excludePath), { recursive: true })
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : ""
  await appendFile(excludePath, `${prefix}${contextIgnorePattern}\n`)
}

const initialDocument = (prompt) => `# Worktree Context

<!-- Local worktree metadata. It is intentionally excluded from Git. -->

## Original Request

${prompt}

## Task Definition

Not yet summarized. Keep this section concise and update it only when the user changes scope.

## Current Handoff

No handoff has been written. Run /worktree-handoff before switching agents.
`

const textFrom = (parts) =>
  parts
    .filter((part) => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")

export const WorktreeContextPlugin = async ({ directory }) => {
  const location = worktreeLocation(directory)

  const ensureContext = async (parts) => {
    const prompt = textFrom(parts)
    if (!prompt) return

    const paths = await location
    if (!paths) return

    try {
      await ensureIgnored(paths.excludePath)
      const existing = await readIfPresent(paths.contextPath)
      if (existing !== null) return
      await writeFile(paths.contextPath, initialDocument(prompt), { flag: "wx" })
    } catch (error) {
      // Context capture must never prevent an agent from responding to the user.
      if (error?.code !== "EEXIST") return
    }
  }

  const injectContext = async (system) => {
    const paths = await location
    if (!paths) return

    try {
      const context = await readIfPresent(paths.contextPath)
      if (context === null) return

      system.push(`## Persisted Worktree Context

The following local document is the durable context for this linked Git worktree. It includes the original request and, when written, a handoff snapshot. Use it as prior context, reconcile it with the current worktree, and obey the current user request if it conflicts.

<worktree-context>
${context}
</worktree-context>`)
    } catch {
      // Failure to read optional context must not interrupt the session.
    }
  }

  return {
    "chat.message": async (_input, output) => {
      await ensureContext(output.parts)
    },
    "experimental.chat.system.transform": async (_input, output) => {
      await injectContext(output.system)
    },
  }
}
