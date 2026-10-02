#!/usr/bin/env node
// Only selected metadata reaches stdout. Never print config documents, API
// stderr, environment, auth, skill bodies, session history or audit records.
import { readFile, realpath } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
const digest = (content) => createHash("sha256").update(content).digest("hex")
const jsonFile = async (path) => JSON.parse(await readFile(path, "utf8"))
const unwrap = (value) => value && !Array.isArray(value) && Object.hasOwn(value, "data") ? value.data : value
const version = (value) => /^(?:opencode v?)?(\d+\.\d+\.\d+)$/.exec(value ?? "")?.[1] ?? "unverified"
const settings = (config) => ({
  search: config.websearch?.provider === "exa" ? "exa" : "other-or-missing",
  maxLines: config.tool_output?.max_lines ?? 2000, maxBytes: config.tool_output?.max_bytes ?? 50 * 1024,
  compactionAuto: config.compaction?.auto ?? true, keepTokens: config.compaction?.keep?.tokens ?? 15000,
  depth: config.experimental?.subagent_depth ?? 1,
})

export async function reportInventory(inventory, root, { cli, installedServer, installedSkills, runtimeOnly = false, command = execFileSync } = {}) {
  if (runtimeOnly && (!cli || !installedServer || !installedSkills)) throw new Error("runtime-only requires explicit installed server, skills and CLI")
  const stale = []
  for (const [path, expected] of Object.entries(runtimeOnly ? {} : { ...inventory.inputs?.files, ...inventory.artifacts })) {
    if (path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("unsafe inventory path")
    const bytes = await readFile(resolve(root, path)).catch(() => null)
    if (!bytes || digest(bytes) !== expected) stale.push(path)
  }
  const report = { intended: { central: inventory.central, profile: inventory.profile, artifactsMatch: runtimeOnly ? "not-inspected" : stale.length === 0, stale },
    installed: { status: "not-inspected" }, active: { status: "not-inspected" } }
  let valid = stale.length === 0
  const expectedConfig = await jsonFile(runtimeOnly ? installedServer : resolve(root, inventory.server))
  if (installedServer) {
    const content = await readFile(installedServer)
    report.installed = { status: "server-file-inspected", serverFileMatches: digest(content) === inventory.artifacts[inventory.server] }
    valid &&= report.installed.serverFileMatches
  }
  if (cli) {
    const invoke = (args) => command(cli, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] })
    const api = (path) => unwrap(JSON.parse(invoke(["api", "get", path])))
    const all = api("/api/plugin")
    const shared = all.filter((plugin) => plugin.source?.type === "package" && plugin.source.target?.startsWith("git+ssh://git@github.com/tomasmota/agents.git#"))
    const plugins = all.filter((plugin) => plugin.source?.type === "package" && /^git\+ssh:\/\/git@github\.com\/tomasmota\/agents\.git#[0-9a-f]{40}::path:opencode\/plugins\/[a-z-]+$/.test(plugin.source.target))
    const expected = inventory.packages.map((pkg) => ({ ...pkg, target: `git+ssh://git@github.com/tomasmota/agents.git#${inventory.central.revision}::path:${pkg.path}` }))
    report.installed.cliVersion = version(invoke(["--version"]).trim())
    report.installed.packages = expected.map((pkg) => ({ path: pkg.path, resolvedAtPin: plugins.some((plugin) => plugin.source.target === pkg.target && plugin.source.version === inventory.central.revision) }))
    const info = api("/api/info") // ServerInfo is a bare object, not a data envelope.
    const documents = api("/api/config") // Config.Entry[], not merged Config.Info.
    const selected = {}
    for (const document of documents) {
      if (document.type !== "document") continue
      // Config.latest replaces the entire setting, not its missing fields.
      for (const key of ["websearch", "tool_output", "experimental"]) {
        if (document.info?.[key] !== undefined) selected[key] = document.info[key]
      }
      // 2.0.16's compaction plugin is different: it configures each explicitly
      // defined scalar in document order (src/config/plugin/compaction.ts).
      const compaction = document.info?.compaction
      if (compaction) {
        selected.compaction ??= {}
        if (compaction.auto !== undefined) selected.compaction.auto = compaction.auto
        if (compaction.keep?.tokens !== undefined) selected.compaction.keep = { tokens: compaction.keep.tokens }
      }
    }
    const observed = settings(selected)
    // Emit only scalar fields of the native schema, never an arbitrary subtree.
    for (const [key, value] of Object.entries(observed)) if (key !== "search" && !["number", "boolean", "undefined"].includes(typeof value)) observed[key] = "unexpected"
    report.active = { serverVersion: version(info.version),
      packages: expected.map((pkg) => ({ path: pkg.path, activeAtPin: plugins.some((plugin) => plugin.source.target === pkg.target && plugin.source.version === inventory.central.revision && plugin.state?.status === "active") })),
      configuration: observed, configurationSource: "loaded documents; not per-request hook overrides" }
    report.active.runtimeMatches = report.active.serverVersion === inventory.central.opencode && report.installed.cliVersion === inventory.central.opencode
    report.active.configurationMatches = JSON.stringify(observed) === JSON.stringify(settings(expectedConfig))
    report.active.matchesPin = report.active.packages.every((pkg) => pkg.activeAtPin) && shared.length === expected.length && !all.some((plugin) => plugin.state?.status === "failed")
    if (installedSkills) {
      const skills = api("/api/skill")
      report.installed.skills = []
      for (const [id, skill] of Object.entries(inventory.skills)) {
        let filesMatch = true
        for (const [path, expectedHash] of Object.entries(skill.files)) {
          const bytes = await readFile(resolve(installedSkills, id, path)).catch(() => null)
          filesMatch &&= Boolean(bytes && digest(bytes) === expectedHash)
        }
        const actual = skills.find((item) => item.id === id)
        const canonical = await realpath(resolve(installedSkills, id, "SKILL.md"))
        const actualPath = actual?.path ? await realpath(actual.path).catch(() => null) : null
        const sourceMatches = actualPath === canonical
        report.installed.skills.push({ id, filesMatch, activeSourceMatches: sourceMatches })
        valid &&= filesMatch && sourceMatches
      }
    }
    valid &&= report.active.runtimeMatches && report.active.configurationMatches && report.active.matchesPin
  }
  return { report, valid }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
    if (!option("--inventory") || !option("--root")) throw new Error("explicit inventory and consumer root required")
    const { report, valid } = await reportInventory(await jsonFile(resolve(option("--inventory"))), resolve(option("--root")), {
      cli: option("--opencode"), installedServer: option("--installed-server"), installedSkills: option("--installed-skills"), runtimeOnly: args.includes("--runtime-only"),
    })
    console.log(JSON.stringify(report, null, 2))
    if (!valid) process.exitCode = 1
  } catch {
    console.error("agent inventory failed: check explicit paths, CLI connection and API compatibility; raw diagnostic data suppressed")
    process.exitCode = 1
  }
}
