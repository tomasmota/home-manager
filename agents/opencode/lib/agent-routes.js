import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const ROUTES_FILE = process.env.OPENCODE_ROUTES_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "subagents.jsonc")
export const STATE_MAX_AGE_MS = 15 * 60_000

// Written by the agent-routes plugin:
// { updatedAt, errors, low, agents: { [id]: { model, fallbackFrom? } },
//   quota: { [providerID]: { fiveHourLeft?, weeklyLeft?, checkedAt } },
//   exhausted: { [providerID]: { detectedAt, until, windowMs } } }  (quota failures seen at runtime)
export function statePath(env = process.env) {
  return join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode", "agent-routes.json")
}

export async function readState({ path = statePath(), now = Date.now(), maxAgeMs = STATE_MAX_AGE_MS } = {}) {
  try {
    const state = JSON.parse(await readFile(path, "utf8"))
    return now - state?.updatedAt <= maxAgeMs ? state : undefined
  } catch {
    return undefined
  }
}

// Stale entries are dropped, so unknown quota never triggers a fallback.
export function freshQuota(quota, { now = Date.now(), maxAgeMs = STATE_MAX_AGE_MS } = {}) {
  return Object.fromEntries(
    Object.entries(quota ?? {}).filter(([, entry]) => typeof entry?.checkedAt === "number" && now - entry.checkedAt <= maxAgeMs),
  )
}

// Keeps the newest reading per provider; readings from other processes arrive through the state file.
export function mergeQuota(known, incoming) {
  const merged = { ...known }
  for (const [provider, entry] of Object.entries(incoming ?? {})) {
    if (entry?.checkedAt > (merged[provider]?.checkedAt ?? 0)) merged[provider] = entry
  }
  return merged
}

const MODES = new Set(["primary", "subagent", "all"])
const EFFECTS = new Set(["allow", "ask", "deny"])
const ROOT_KEYS = new Set(["fallbacks", "quotaLow", "permissions", "agents"])
const AGENT_KEYS = new Set(["mode", "model", "description", "system", "hidden", "color", "steps", "permissions"])

// Comments and trailing commas only; strings are copied verbatim.
export function parseJsonc(text) {
  const afterComment = (at) => {
    if (text[at] !== "/") return at
    if (text[at + 1] === "/") {
      const end = text.indexOf("\n", at)
      return end === -1 ? text.length : end
    }
    if (text[at + 1] === "*") {
      const end = text.indexOf("*/", at + 2)
      if (end === -1) throw new SyntaxError("Unterminated block comment")
      return end + 2
    }
    return at
  }
  const nextSignificant = (at) => {
    while (at < text.length) {
      const skipped = afterComment(at)
      if (skipped !== at) at = skipped
      else if (/\s/.test(text[at])) at++
      else return text[at]
    }
    return undefined
  }

  let out = ""
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const skipped = afterComment(i)
    if (ch === '"') {
      const start = i++
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1
      out += text.slice(start, ++i)
    } else if (skipped !== i) {
      i = skipped
    } else {
      const trailingComma = ch === "," && ["}", "]"].includes(nextSignificant(i + 1))
      if (!trailingComma) out += ch
      i++
    }
  }
  return JSON.parse(out)
}

export function parseModelRef(value) {
  if (typeof value !== "string") return null
  const slash = value.indexOf("/")
  if (slash <= 0) return null
  const hash = value.indexOf("#", slash)
  const id = value.slice(slash + 1, hash === -1 ? undefined : hash)
  const variant = hash === -1 ? undefined : value.slice(hash + 1)
  if (!id || variant === "") return null
  return { providerID: value.slice(0, slash), id, ...(variant ? { variant } : {}) }
}

export function formatModelRef(ref) {
  return `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function checkPermissions(list, where, errors) {
  if (list === undefined) return []
  if (!Array.isArray(list)) {
    errors.push(`${where}: permissions must be an array`)
    return []
  }
  return list.filter((rule, index) => {
    const ok =
      isRecord(rule) &&
      typeof rule.action === "string" &&
      typeof rule.resource === "string" &&
      EFFECTS.has(rule.effect) &&
      (rule.when === undefined || rule.when === "child" || rule.when === "primary")
    if (!ok) errors.push(`${where}: permissions[${index}] needs action, resource, effect (allow|ask|deny), optional when (child|primary)`)
    return ok
  })
}

// Structural validation only; model availability is checked by the caller.
// Invalid agents are reported in `errors` and left out of `routes.agents`.
export function validateRoutes(raw) {
  const errors = []
  if (!isRecord(raw)) return { errors: ["root must be an object"], routes: { agents: {}, fallbacks: {}, quotaLow: {} } }
  if (!isRecord(raw.agents) || Object.keys(raw.agents).length === 0) errors.push("agents must be a non-empty object")
  for (const key of Object.keys(raw)) {
    if (!ROOT_KEYS.has(key)) errors.push(`unknown key "${key}"`)
  }

  const fallbacks = {}
  for (const [provider, model] of Object.entries(isRecord(raw.fallbacks) ? raw.fallbacks : {})) {
    if (parseModelRef(model)) fallbacks[provider] = model
    else errors.push(`fallbacks.${provider}: expected "provider/model[#variant]"`)
  }

  const quotaLow = { fiveHour: 20, weekly: 10, ...(isRecord(raw.quotaLow) ? raw.quotaLow : {}) }
  for (const key of ["fiveHour", "weekly"]) {
    if (!Number.isFinite(quotaLow[key])) errors.push(`quotaLow.${key} must be a number`)
  }

  const permissions = checkPermissions(raw.permissions, "permissions", errors)
  const agents = {}
  for (const [id, agent] of Object.entries(isRecord(raw.agents) ? raw.agents : {})) {
    const where = `agents.${id}`
    if (!isRecord(agent)) {
      errors.push(`${where} must be an object`)
      continue
    }
    const before = errors.length
    for (const key of Object.keys(agent)) {
      if (!AGENT_KEYS.has(key)) errors.push(`${where}: unknown key "${key}"`)
    }
    if (!parseModelRef(agent.model)) errors.push(`${where}.model: expected "provider/model[#variant]"`)
    if (typeof agent.description !== "string" || !agent.description.trim()) errors.push(`${where}.description is required`)
    const mode = agent.mode ?? "subagent"
    if (!MODES.has(mode)) errors.push(`${where}.mode must be primary, subagent, or all`)
    const system = Array.isArray(agent.system) ? agent.system.join("\n") : agent.system
    if (system !== undefined && typeof system !== "string") errors.push(`${where}.system must be a string or array of strings`)
    const own = checkPermissions(agent.permissions, where, errors)
    if (errors.length > before) continue
    agents[id] = {
      id,
      mode,
      model: agent.model,
      description: agent.description,
      ...(system ? { system } : {}),
      ...(agent.hidden === true ? { hidden: true } : {}),
      ...(typeof agent.color === "string" ? { color: agent.color } : {}),
      ...(Number.isInteger(agent.steps) && agent.steps > 0 ? { steps: agent.steps } : {}),
      permissions: [...permissions, ...own],
    }
  }
  return { errors, routes: { agents, fallbacks, quotaLow } }
}

export async function loadRoutes(path = ROUTES_FILE) {
  const { errors, routes } = validateRoutes(parseJsonc(await readFile(path, "utf8")))
  if (errors.length) throw new Error(`${path}: ${errors.join("; ")}`)
  return routes
}

// quota: { [providerID]: { fiveHourLeft?: number, weeklyLeft?: number } }
export function lowProviders(quota, thresholds) {
  const low = new Set()
  for (const [provider, state] of Object.entries(quota ?? {})) {
    if (state?.fiveHourLeft < thresholds.fiveHour || state?.weeklyLeft < thresholds.weekly) low.add(provider)
  }
  return low
}

// Falls back when the provider is low on quota or not configured on this machine.
// A fallback without #variant keeps the agent's variant when the fallback model supports it.
// No chaining: when the fallback is also low or unavailable, the configured model stays.
export function effectiveModel(model, { fallbacks, low, variantsOf = () => undefined, unavailable = () => false }) {
  const ref = parseModelRef(model)
  if (!ref || !fallbacks[ref.providerID] || !(low.has(ref.providerID) || unavailable(model))) return { model }
  const target = parseModelRef(fallbacks[ref.providerID])
  if (low.has(target.providerID) || unavailable(fallbacks[ref.providerID])) return { model }
  if (!target.variant && ref.variant) {
    const variants = variantsOf(`${target.providerID}/${target.id}`)
    if (!variants || variants.includes(ref.variant)) target.variant = ref.variant
  }
  return { model: formatModelRef(target), fallbackFrom: model }
}

// Mirrors OpenCode's Wildcard.match.
export function wildcardMatch(input, pattern) {
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`
  return new RegExp(`^${escaped}$`, "s").test(input.replaceAll("\\", "/"))
}

const STRICTNESS = { allow: 0, ask: 1, deny: 2 }

// Last matching rule wins per resource; the strictest result across resources wins.
// Resources no rule matches keep `current`. Returns undefined when nothing matched.
export function evaluateRules(rules, action, resources, current) {
  let matched = false
  let result
  for (const resource of resources) {
    const rule = rules.findLast((item) => wildcardMatch(action, item.action) && wildcardMatch(resource, item.resource))
    if (rule) matched = true
    const effect = rule?.effect ?? current
    if (result === undefined || STRICTNESS[effect] > STRICTNESS[result]) result = effect
  }
  return matched ? result : undefined
}

export function primaryAgents(routes) {
  return Object.values(routes.agents).filter((agent) => agent.mode !== "subagent" && !agent.hidden)
}
