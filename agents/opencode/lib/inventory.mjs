#!/usr/bin/env node
// Only selected metadata reaches stdout. Never print config documents, API
// stderr, environment, auth, skill bodies, session history or audit records.
import { readFile, realpath } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
const digest = (content) => createHash("sha256").update(content).digest("hex")
const jsonFile = async (path) => JSON.parse(await readFile(path, "utf8"))
const unwrap = (value) => value && !Array.isArray(value) && Object.hasOwn(value, "data") ? value.data : value
const version = (value) => /^(?:opencode v?)?(\d+\.\d+\.\d+)$/.exec(value ?? "")?.[1] ?? "unverified"
// Keep in step with COMPATIBLE_OPENCODE in render.mjs (this file is installed standalone).
export const COMPATIBLE_OPENCODE = Object.freeze(["2.0.16", "2.0.22"])
// An explicit --server must be a bare http(s) URL: no credentials, query or fragment.
// Authentication comes only from the CLI's own OPENCODE_PASSWORD environment.
export function serverOrigin(value) {
  const url = new URL(value)
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid server URL")
  return url.origin
}
// An explicit --directory must be an unambiguous absolute path (the server resolves it).
export function locationDirectory(value) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\0\n\r]/.test(value)) throw new Error("invalid directory")
  return value
}
const settings = (config) => ({
  search: config.websearch?.provider === "exa" ? "exa" : "other-or-missing",
  maxLines: config.tool_output?.max_lines ?? 2000, maxBytes: config.tool_output?.max_bytes ?? 50 * 1024,
  compactionAuto: config.compaction?.auto ?? true, keepTokens: config.compaction?.keep?.tokens ?? 15000,
  depth: config.experimental?.subagent_depth ?? 1,
})

export async function reportInventory(inventory, root, { cli, server, directory, installedServer, installedSkills, runtimeOnly = false, command = execFileSync } = {}) {
  if (server !== undefined && !cli) throw new Error("--server requires an explicit CLI")
  const origin = server === undefined ? undefined : serverOrigin(server)
  if (directory !== undefined) locationDirectory(directory)
  if (directory !== undefined && !cli) throw new Error("--directory requires an explicit CLI")
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
    // `api --server` selects an explicit V2 server; otherwise the CLI uses its background
    // service. The connection mode is reported, never guessed from the URL or its owner.
    // Only the location-scoped lists take `location[directory]` (documented deepObject
    // query); /api/info does not. Without --directory the server's default location applies.
    const call = (path, located) => JSON.parse(invoke(["api", ...(server === undefined ? [] : ["--server", server]), "get",
      located && directory !== undefined ? `${path}?location[directory]=${encodeURIComponent(directory)}` : path]))
    const api = (path) => unwrap(call(path, false))
    const locationOf = (value) => typeof value?.location?.directory === "string" ? value.location.directory : undefined
    const listed = (path) => { const value = call(path, true); return { data: unwrap(value), directory: locationOf(value) } }
    const pluginList = listed("/api/plugin")
    const all = pluginList.data
    const shared = all.filter((plugin) => plugin.source?.type === "package" && plugin.source.target?.startsWith("git+ssh://git@github.com/tomasmota/agents.git#"))
    const plugins = all.filter((plugin) => plugin.source?.type === "package" && /^git\+ssh:\/\/git@github\.com\/tomasmota\/agents\.git#[0-9a-f]{40}::path:opencode\/plugins\/[a-z-]+$/.test(plugin.source.target))
    const expected = inventory.packages.map((pkg) => ({ ...pkg, target: `git+ssh://git@github.com/tomasmota/agents.git#${inventory.central.revision}::path:${pkg.path}` }))
    report.installed.cliVersion = version(invoke(["--version"]).trim())
    report.installed.packages = expected.map((pkg) => ({ path: pkg.path, resolvedAtPin: plugins.some((plugin) => plugin.source.target === pkg.target && plugin.source.version === inventory.central.revision) }))
    const info = api("/api/info") // ServerInfo is a bare object, not a data envelope.
    const documents = listed("/api/config").data // Config.Entry[], not merged Config.Info.
    const selected = {}
    for (const document of documents) {
      if (document.type !== "document") continue
      // Config.latest replaces the entire setting, not its missing fields.
      for (const key of ["websearch", "tool_output", "experimental"]) {
        if (document.info?.[key] !== undefined) selected[key] = document.info[key]
      }
      // 2.0.16 and 2.0.22 share this compaction merge: each explicitly defined
      // scalar is configured in document order (src/config/plugin/compaction.ts).
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
    report.active = { connection: server === undefined ? "default-service" : "explicit-server", ...(origin ? { serverOrigin: origin } : {}),
      serverVersion: version(info.version), serverPID: Number.isSafeInteger(info.pid) && info.pid > 0 ? info.pid : null,
      packages: expected.map((pkg) => ({ path: pkg.path, activeAtPin: plugins.some((plugin) => plugin.source.target === pkg.target && plugin.source.version === inventory.central.revision && plugin.state?.status === "active") })),
      configuration: observed, configurationSource: "loaded documents; not per-request hook overrides" }
    report.active.lockSupported = COMPATIBLE_OPENCODE.includes(inventory.central.opencode)
    report.active.runtimeMatches = report.active.lockSupported && report.active.serverVersion === inventory.central.opencode && report.installed.cliVersion === inventory.central.opencode
    report.active.configurationMatches = JSON.stringify(observed) === JSON.stringify(settings(expectedConfig))
    report.active.matchesPin = report.active.packages.every((pkg) => pkg.activeAtPin) && shared.length === expected.length && !all.some((plugin) => plugin.state?.status === "failed")
    let skillDirectory
    if (installedSkills) {
      const skillList = listed("/api/skill")
      const skills = skillList.data
      skillDirectory = skillList.directory
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
    // Actual location comes from the response envelope, never from the request. Plugin and
    // skill lists must agree, and an explicit request must be what the server reports
    // (exactly, or after resolving the local path, e.g. a symlinked temp directory).
    const reported = pluginList.directory
    let accepted = directory === undefined ? true : reported === resolve(directory)
    if (directory !== undefined && !accepted && reported !== undefined) accepted = reported === await realpath(directory).catch(() => undefined)
    report.active.location = { selection: directory === undefined ? "server-default" : "explicit", directory: reported ?? "unreported",
      ...(installedSkills ? { skillsDirectory: skillDirectory ?? "unreported" } : {}) }
    report.active.location.matchesRequested = directory === undefined ? true : Boolean(accepted) && reported !== undefined
    report.active.location.consistent = reported !== undefined || directory === undefined
    if (installedSkills && skillDirectory !== reported) report.active.location.consistent = false
    valid &&= report.active.location.matchesRequested && report.active.location.consistent
    valid &&= report.active.runtimeMatches && report.active.configurationMatches && report.active.matchesPin
  }
  return { report, valid }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
    // A present --server/--directory must never silently fall back to defaults.
    for (const name of ["--server", "--directory"]) if (args.includes(name) && (!option(name) || option(name).startsWith("--"))) throw new Error(`missing ${name} value`)
    if (!option("--inventory") || !option("--root")) throw new Error("explicit inventory and consumer root required")
    const { report, valid } = await reportInventory(await jsonFile(resolve(option("--inventory"))), resolve(option("--root")), {
      cli: option("--opencode"), server: option("--server"), directory: option("--directory"), installedServer: option("--installed-server"), installedSkills: option("--installed-skills"), runtimeOnly: args.includes("--runtime-only"),
    })
    console.log(JSON.stringify(report, null, 2))
    if (!valid) process.exitCode = 1
  } catch {
    console.error("agent inventory failed: check explicit paths, CLI connection and API compatibility; raw diagnostic data suppressed")
    process.exitCode = 1
  }
}
