// Generates OpenCode agents from agents/opencode/subagents.jsonc, hot-reloads edits,
// applies quota/availability fallbacks, and enforces `when`-scoped permission rules.

import { randomUUID } from "node:crypto"
import { unwatchFile, watchFile } from "node:fs"
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import {
  ROUTES_FILE,
  effectiveModel,
  evaluateRules,
  freshQuota,
  lowProviders,
  parseJsonc,
  parseModelRef,
  readState,
  statePath,
  validateRoutes,
} from "../../lib/agent-routes.js"
import { QUOTA_SOURCES, fetchQuotaShared } from "./quota.js"

const QUOTA_REFRESH_MS = 5 * 60_000
const MISSING_RECHECK_MS = 15_000
const MISSING_RECHECKS = 8
const LOG_FILE = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "log", "agent-routes.log")

function unwrap(value) {
  return value && typeof value === "object" && !Array.isArray(value) && "data" in value ? value.data : value
}

async function setupAgentRoutes(ctx, { routesFile, stateFile, logFile, quotaSources, pollFileMs }) {
  let routes
  let effective = {}
  let errors = []
  let signature = ""
  let models = new Map()
  let providerIDs = new Set()
  let quota = freshQuota((await readState({ path: stateFile, maxAgeMs: Infinity }))?.quota)
  let disposed = false
  let missingRechecks = 0
  const childSessions = new Map()

  async function log(message) {
    console.error(`[agent-routes] ${message}`)
    try {
      await mkdir(dirname(logFile), { recursive: true })
      await appendFile(logFile, `${new Date().toISOString()} ${message}\n`)
    } catch {}
  }

  async function refreshModels() {
    try {
      const list = unwrap(await ctx.model.list())
      if (!Array.isArray(list) || list.length === 0) return
      models = new Map(
        list.map((model) => [
          `${model.providerID}/${model.id}`,
          (model.variants ?? []).map((variant) => (typeof variant === "string" ? variant : variant.id)),
        ]),
      )
      providerIDs = new Set(list.map((model) => model.providerID))
    } catch (error) {
      await log(`model list failed: ${error}`)
    }
  }

  // Before the model list loads, nothing counts as unavailable or invalid.
  const unavailable = (model) => models.size > 0 && !providerIDs.has(parseModelRef(model)?.providerID)

  function modelError(model, fallbacks) {
    if (models.size === 0) return undefined
    const ref = parseModelRef(model)
    if (unavailable(model)) {
      return fallbacks && !fallbacks[ref.providerID] ? `provider ${ref.providerID} is not configured here and has no fallback` : undefined
    }
    const variants = models.get(`${ref.providerID}/${ref.id}`)
    if (!variants) return `${model} is not an available model`
    if (ref.variant && !variants.includes(ref.variant)) {
      return `${model} has no variant "${ref.variant}" (available: ${variants.join(", ") || "none"})`
    }
    return undefined
  }

  async function readRoutes() {
    let parsed
    try {
      parsed = validateRoutes(parseJsonc(await readFile(routesFile, "utf8")))
    } catch (error) {
      return { problems: [`${basename(routesFile)}: ${error.message ?? error}`] }
    }
    const problems = [...parsed.errors]
    const next = parsed.routes
    for (const [provider, model] of Object.entries(next.fallbacks)) {
      const problem = modelError(model)
      if (problem) {
        problems.push(`fallbacks.${provider}: ${problem}`)
        delete next.fallbacks[provider]
      }
    }
    for (const [id, agent] of Object.entries(next.agents)) {
      const problem = modelError(agent.model, next.fallbacks)
      if (problem) {
        problems.push(`agents.${id}.model: ${problem}`)
        delete next.agents[id]
      }
    }
    return { problems, next }
  }

  async function writeState(low) {
    try {
      await mkdir(dirname(stateFile), { recursive: true })
      const tmp = `${stateFile}.${process.pid}.${randomUUID()}.tmp`
      const state = { updatedAt: Date.now(), file: routesFile, errors, low: [...low], agents: effective, quota }
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`)
      await rename(tmp, stateFile)
    } catch (error) {
      await log(`state write failed: ${error}`)
    }
  }

  // An invalid edit keeps the last good routes; at startup the valid entries still apply.
  async function sync() {
    if (disposed) return
    await refreshModels()
    const { problems, next } = await readRoutes()
    if (problems.join("\n") !== errors.join("\n")) {
      await log(
        problems.length
          ? `${routes ? "kept the last good routes" : "skipped invalid entries"}: ${problems.join("; ")}`
          : "routes valid",
      )
    }
    errors = problems
    if (next && (problems.length === 0 || !routes)) routes = next
    if (disposed) return
    if (!routes) {
      effective = {}
      await writeState(new Set())
      return
    }

    const low = lowProviders(quota, routes.quotaLow)
    const nextEffective = {}
    for (const agent of Object.values(routes.agents)) {
      const entry = effectiveModel(agent.model, {
        fallbacks: routes.fallbacks,
        low,
        unavailable,
        variantsOf: (key) => models.get(key),
      })
      const before = effective[agent.id]
      if (before && before.model !== entry.model && (before.fallbackFrom || entry.fallbackFrom)) {
        await log(`${agent.id}: ${before.model} -> ${entry.model}`)
      }
      nextEffective[agent.id] = entry
    }
    effective = nextEffective
    await writeState(low)

    // The model list can be partial while providers load, so keep re-checking a missing provider for a while.
    const missing = Object.values(routes.agents).some((agent) => unavailable(agent.model))
    if (missing && missingRechecks < MISSING_RECHECKS) {
      missingRechecks++
      scheduleSync(MISSING_RECHECK_MS)
    }

    const nextSignature = JSON.stringify([routes.agents, effective])
    if (disposed || nextSignature === signature) return
    signature = nextSignature
    await ctx.agent.reload()
  }

  let queue = Promise.resolve()
  const queueSync = () => {
    if (disposed) return queue
    queue = queue.then(sync).catch((error) => log(`sync failed: ${error}`))
    return queue
  }

  let pendingSync
  function scheduleSync(delayMs) {
    if (disposed || pendingSync) return
    pendingSync = setTimeout(() => {
      pendingSync = undefined
      void queueSync()
    }, delayMs)
    pendingSync.unref?.()
  }

  // Merges readings from other processes (via the state file) so each provider is fetched about once per interval per machine.
  async function refreshQuota() {
    if (!routes) return
    const fromFile = (await readState({ path: stateFile, maxAgeMs: Infinity }))?.quota ?? {}
    const known = { ...quota }
    for (const [provider, entry] of Object.entries(fromFile)) {
      if (entry?.checkedAt > (known[provider]?.checkedAt ?? 0)) known[provider] = entry
    }
    const wanted = new Set(
      Object.entries(routes.fallbacks).flatMap(([provider, model]) => [provider, parseModelRef(model).providerID]),
    )
    const sources = Object.entries(quotaSources).filter(([provider]) => wanted.has(provider))
    const results = await Promise.allSettled(
      sources.map(async ([provider, fetchQuota]) => [
        provider,
        await fetchQuotaShared(provider, fetchQuota, { cached: known[provider], maxAgeMs: QUOTA_REFRESH_MS - 30_000 }),
      ]),
    )
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled" && result.value[1]) known[result.value[0]] = result.value[1]
      else if (result.status === "rejected") await log(`${sources[index][0]} quota failed: ${result.reason}`)
    }
    quota = freshQuota(known)
  }

  // A failed lookup counts as a child session, so child-only restrictions fail closed.
  async function isChild(sessionID) {
    if (childSessions.has(sessionID)) return childSessions.get(sessionID)
    let session
    try {
      session = unwrap(await ctx.session.get({ sessionID }))
    } catch (error) {
      await log(`session lookup failed for ${sessionID}: ${error}`)
      return true
    }
    if (!session || typeof session !== "object") return true
    const child = Boolean(session.parentID)
    childSessions.set(sessionID, child)
    if (childSessions.size > 1024) childSessions.delete(childSessions.keys().next().value)
    return child
  }

  async function scopedRules(agentID, sessionID) {
    const rules = routes?.agents[agentID]?.permissions.filter((rule) => rule.when) ?? []
    if (rules.length === 0) return []
    const scope = (await isChild(sessionID)) ? "child" : "primary"
    return rules.filter((rule) => rule.when === scope)
  }

  await queueSync()

  const registrations = []
  registrations.push(
    await ctx.agent.transform((editor) => {
      for (const agent of Object.values(routes?.agents ?? {})) {
        try {
          // Start from OpenCode's defaults so built-ins (general, explore) are fully replaced.
          editor.remove(agent.id)
          editor.update(agent.id, (info) => {
            const external = info.permissions.filter((rule) => rule.action === "external_directory" && rule.effect === "allow")
            info.mode = agent.mode
            info.description = agent.description
            info.model = parseModelRef(effective[agent.id]?.model ?? agent.model)
            info.hidden = agent.hidden ?? false
            if (agent.system) info.system = agent.system
            if (agent.color) info.color = agent.color
            if (agent.steps) info.steps = agent.steps
            const rules = agent.permissions.filter((rule) => !rule.when)
            info.permissions.push(...rules.map(({ action, resource, effect }) => ({ action, resource, effect })), ...external)
          })
        } catch (error) {
          void log(`agent ${agent.id} failed: ${error}`)
        }
      }
    }),
  )

  registrations.push(
    await ctx.permission.hook("evaluate", async (event) => {
      if (!event.agent || !event.sessionID) return
      try {
        const rules = await scopedRules(event.agent, event.sessionID)
        const effect = rules.length ? evaluateRules(rules, event.action, event.resources ?? [], event.effect) : undefined
        if (!effect || effect === event.effect) return
        event.effect = effect
        if (effect === "deny") event.message = `${event.agent} may not ${event.action} ${event.resources.join(", ")} here`
      } catch (error) {
        await log(`permission hook failed: ${error}`)
      }
    }),
  )

  // Hide subagents the session may not spawn from its catalog.
  const trimCatalog = async (event) => {
    const tool = event.tools?.subagent
    if (!tool || !event.agent || !event.sessionID) return
    try {
      const rules = await scopedRules(event.agent, event.sessionID)
      if (rules.length === 0) return
      tool.description = tool.description
        .split("\n")
        .filter((line) => {
          const id = /^- ([^:\s]+): /.exec(line)?.[1]
          return !id || evaluateRules(rules, "subagent", [id], "allow") !== "deny"
        })
        .join("\n")
    } catch (error) {
      await log(`catalog trim failed: ${error}`)
    }
  }
  for (const name of ["context", "compaction", "generate"]) {
    registrations.push(await ctx.session.hook(name, trimCatalog))
  }

  await ctx.agent.reload()

  const onFileChange = () => void queueSync()
  watchFile(routesFile, { interval: pollFileMs }, onFileChange)
  const tick = () =>
    void refreshQuota()
      .catch((error) => log(`quota refresh failed: ${error}`))
      .then(queueSync)
  const timer = setInterval(tick, QUOTA_REFRESH_MS)
  timer.unref?.()
  tick()

  // Providers finish loading after plugins start; re-check models as soon as they change.
  const events = new AbortController()
  if (typeof ctx.event?.subscribe === "function") {
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          if (event?.type === "model.updated" || event?.type === "provider.updated") scheduleSync(500)
        }
      } catch (error) {
        if (!disposed) await log(`event stream ended: ${error}`)
      }
    })()
  }

  // An in-flight quota refresh may still resolve; `disposed` keeps it from syncing.
  return async () => {
    disposed = true
    events.abort()
    clearInterval(timer)
    clearTimeout(pendingSync)
    unwatchFile(routesFile, onFileChange)
    await queue
    await Promise.allSettled(registrations.map((registration) => registration?.dispose?.()))
  }
}

export function createAgentRoutes({
  routesFile = ROUTES_FILE,
  stateFile = statePath(),
  logFile = LOG_FILE,
  quotaSources = QUOTA_SOURCES,
  pollFileMs = 1_000,
} = {}) {
  return {
    id: "tomas.agent-routes",
    setup: (ctx) => setupAgentRoutes(ctx, { routesFile, stateFile, logFile, quotaSources, pollFileMs }),
  }
}

export default createAgentRoutes()
