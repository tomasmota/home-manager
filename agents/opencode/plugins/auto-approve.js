// Auto-approve plugin (event-based): very permissive, resilient reviewer chain.
//
// Replaces opencode-auto-permissions. Local file = single source of truth,
// no version pin, no 4-file duplication. Tune at runtime via env, no rebuild:
//
//   OPENCODE_REVIEW_MODELS="openai/gpt-5.6-luna,opencode/muse-spark-1.3-contributor-free,zai-coding-plan/glm-5.3-flash"  # comma-separated primaries (default)
//   OPENCODE_REVIEW_NO_SESSION_FALLBACK=1         # disable session-model fallback
//   OPENCODE_REVIEW_TIMEOUT_PRIMARY=15000         # ms per primary model
//   OPENCODE_REVIEW_TIMEOUT_FALLBACK=45000        # ms for session-model fallback
//   OPENCODE_REVIEW_ON_EXHAUSTION=allow           # allow|manual|deny
//   OPENCODE_QUOTA_FLOOR=2                        # pause OpenAI reviewer when weekly % left below this (0 disables)
//   OPENCODE_QUOTA_TTL_MS=60000                   # how long a fetched OpenAI quota value is reused
//   OPENCODE_REVIEW_EXTRA="..."                   # appended to reviewer instructions
//   OPENCODE_REVIEW_DEBUG=1                       # or absolute file path; default path below
//   OPENCODE_NO_ALLOWLIST=1                       # disable deterministic allowlist
//   OPENCODE_NO_CACHE=1                           # disable verdict cache
//
// Design notes:
// - Uses the `event` hook on `permission.asked`, NOT the `permission.ask` hook:
//   the latter is declared in the SDK but never fired by the permission engine
//   (verified 2026-09-15: plugin_loaded x2, hook_fired x0). A logging-only
//   `permission.ask` stub is kept so a future runtime that fires it shows up
//   in diagnostics instead of silently changing behavior.
// - Replies "once" on allow (no session-wide "always": every ask gets a fresh
//   review; routine commands are already allowlisted in opencode.json anyway).
// - Behavior (lookup order per request):
//   - Catastrophic commands (rm -rf /, mkfs, dd to disk, ...) deny immediately.
//   - Deterministic allowlist (read-only diagnostics, tmp mkdir, filtered
//     python3 -c, safe just/nix recipes, ...) allows instantly.
// - Verdict cache replays genuine primary-model verdicts (24h TTL).
// - Everything else goes to luna first, then the free zen backup model on
//   quota/timeout, then glm-5.3-flash, then the requesting session's own
//   model, then fail-open (allow) except catastrophic. The zen backup
//   (muse-spark contributor-free) answers in ~5s, so the chain survives
//   OpenAI quota exhaustion without leaning on the slow session-model
//   fallback; glm flash is a third net behind it (slow cold starts, so it
//   runs with the primary timeout and often yields to the session model).
// - Quota floor: when ANY OpenAI rate-limit window (e.g. the 5h window at
//   100% while the weekly window still has headroom) drops below
//   OPENCODE_QUOTA_FLOOR (default 2%) left, OpenAI reviewer candidates are
//   skipped entirely so the remaining quota is reserved for the main agent. Allowlist/cache still apply;
//   non-OpenAI fallbacks still run. Unknown quota never blocks (fail-open).
//   - Any fallback/exhaustion writes diagnostics + best-effort toast so the
//     TUI tells you the primary reviewer is degraded.

const REVIEWER_AGENT_ID = "auto-approve-reviewer"

const BASE_INSTRUCTIONS = `You are a very permissive permission reviewer for an AI coding agent.
Default to ALLOW. Only DENY when ALL are true: (a) the action is clearly dangerous,
(b) the blast radius is large/irreversible, (c) it does not reasonably serve the user's request.

ALLOW these even though they look scary:
- rm -rf / rm -r / del targeting a SPECIFIC project, cache, build, temp, or worktree
  subdirectory (e.g. rm -rf ./build, rm -rf /tmp/foo, rm -rf /home/tomas/project/.venv).
  Only the filesystem root (/), home (~, $HOME), or broad globs (*, /tmp/* as the real
  target) count as large blast radius.
- Ordinary dev work: inspection, edits, tests, builds, git fetch/log/diff/status,
  package installs, tofu plan, kubectl get/describe/logs/diff, etc.
- sudo / deploy / push / publish when they plausibly serve the task.

DENY only: recursive delete of / or ~, mkfs/format, dd to a disk device, fork bombs,
mass credential exfiltration, disabling auth, or contradicting an explicit user prohibition.
When denying, name a safer alternative in one sentence.

Reply with exactly one JSON object, no fences: {"decision":"allow"|"deny","reasonCode":"lower_snake_case","reason":"one short sentence"}.`

function parseModels(raw) {
  if (!raw || !raw.trim()) {
    return [
      { providerID: "openai", id: "gpt-5.6-luna" },
      { providerID: "opencode", id: "muse-spark-1.3-contributor-free" },
      { providerID: "zai-coding-plan", id: "glm-5.3-flash" },
    ]
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const slash = entry.indexOf("/")
      if (slash < 1 || slash === entry.length - 1) throw new Error(`Bad model "${entry}", want provider/model`)
      return { providerID: entry.slice(0, slash).trim(), id: entry.slice(slash + 1).trim() }
    })
}

function numEnv(name, fallback, min, max) {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isInteger(n) || n < min || n > max) return fallback
  return n
}

function diagnosticsPath() {
  const raw = process.env.OPENCODE_REVIEW_DEBUG
  if (raw === undefined || raw === "" || raw === "0" || raw === "false") {
    // Default on: local-only, privacy-minimized. Set OPENCODE_REVIEW_DEBUG=0 to disable.
    const base = process.env.XDG_STATE_HOME || `${process.env.HOME || "/tmp"}/.local/state`
    return `${base}/opencode/auto-approve/decisions.jsonl`
  }
  if (raw === "1" || raw === "true") {
    const base = process.env.XDG_STATE_HOME || `${process.env.HOME || "/tmp"}/.local/state`
    return `${base}/opencode/auto-approve/decisions.jsonl`
  }
  return raw
}

async function appendDiagnostic(record) {
  try {
    const path = diagnosticsPath()
    if (!path) return
    const { mkdir, appendFile } = await import("node:fs/promises")
    const { dirname } = await import("node:path")
    await mkdir(dirname(path), { recursive: true })
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...record })
    await appendFile(path, `${line}\n`, "utf8")
    // Keep file bounded; ignore rotation errors.
    const { stat, readFile, writeFile } = await import("node:fs/promises")
    try {
      const st = await stat(path)
      if (st.size > 512 * 1024) {
        const text = await readFile(path, "utf8")
        await writeFile(path, text.split("\n").slice(-400).join("\n"), "utf8")
      }
    } catch {}
  } catch {}
}

async function showToast(client, message) {
  try {
    if (client?.tui?.showToast) {
      await client.tui.showToast({ message, variant: "warning", duration: 5000 }).catch(() => undefined)
      return
    }
    if (client?.tui?.toast) {
      await client.tui.toast({ message }).catch(() => undefined)
      return
    }
  } catch {}
}

function recordOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null
}

function stringList(value) {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string")
  return []
}

// Normalize both permission shapes:
// - v2 PermissionRequest: {id, sessionID, permission, patterns[], metadata, always|save, tool?}
// - v1 Permission: {id, sessionID, type, pattern, title, metadata, messageID, callID}
function normalizeRequest(payload) {
  const rec = recordOf(payload)
  if (!rec || typeof rec.id !== "string" || typeof rec.sessionID !== "string") return null
  const action = rec.permission ?? rec.action ?? rec.type
  let resources = stringList(rec.patterns ?? rec.resources)
  if (resources.length === 0) resources = stringList(rec.pattern)
  if (typeof action !== "string" || resources.length === 0) return null
  const always = stringList(rec.always ?? rec.save)
  const tool = recordOf(rec.tool)
  const title = typeof rec.title === "string" ? rec.title : undefined
  const metadata = recordOf(rec.metadata)
  return { id: rec.id, sessionID: rec.sessionID, action, resources, always, tool, title, metadata }
}

function permissionText(req) {
  const parts = [req.action]
  if (req.title) parts.push(req.title)
  parts.push(...req.resources)
  if (req.metadata) {
    try {
      parts.push(JSON.stringify(req.metadata).slice(0, 500))
    } catch {}
  }
  return parts.join("\n").slice(0, 2000)
}

function isCatastrophic(text) {
  const t = text || ""
  // rm -rf / or ~ ($HOME) as a real target. Specific subdirs are NOT catastrophic.
  if (/(?:^|\s)rm\s+-[^\s]*r[^\s]*\s+(?:--\s+)?(?:["']?\/["']?|["']?~["']?|["']?\$HOME["']?)(?:\s|$|;|&|\|)/i.test(t)) return true
  if (/\bmkfs\b/i.test(t)) return true
  if (/\bdd\s+.*\bof=\/dev\/(?:sd|hd|nvme|vd|xvd)/i.test(t)) return true
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/.test(t)) return true // fork bomb
  return false
}

// ---- Speed package: deterministic allowlist + verdict cache ----

const CACHE_VERSION = 1 // bump when BASE_INSTRUCTIONS or rules below change
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CACHE_MAX_ENTRIES = 500

function cachePath() {
  const base = process.env.XDG_STATE_HOME || `${process.env.HOME || "/tmp"}/.local/state`
  return `${base}/opencode/auto-approve/verdict-cache.json`
}

function normalizeCommand(text) {
  return (text || "").trim().replace(/\s+/g, " ")
}

function isTmpPath(p) {
  const clean = (p || "").replace(/^["']|["']$/g, "")
  return /^(\/tmp\/|\$TMPDIR\/|\$\{TMPDIR\}\/|\/dev\/null$)/.test(clean)
}

// Global guards: any allowlist candidate must satisfy all of these.
function passesAllowGuards(text) {
  const t = text || ""
  if (/(~\/\.ssh|credential|token|secret|\.env\b)/i.test(t)) return false
  if (/\|\s*(bash|sh|zsh|fish|dash|eval|exec)\b/i.test(t)) return false
  if (/`[^`]*`/.test(t) || /\$\([^)]*\)/.test(t)) return false // command substitution
  return true
}

// Redirect targets are constrained to tmp; returns the segment with
// redirects stripped, or null when a target is outside tmp.
function stripRedirects(seg) {
  const noArrow = seg.replace(/=>/g, "")
  const targets = [...noArrow.matchAll(/>>?\s*([^\s;|&]+)/g)].map((m) => m[1])
  for (const t of targets) {
    if (!isTmpPath(t)) return null
  }
  return noArrow.replace(/>>?\s*[^\s;|&]+/g, "").trim()
}

function unquoteOnce(s) {
  const t = (s || "").trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

function tokenize(s) {
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ""))
}

const PYTHON_FORBIDDEN = /subprocess|os\.(system|exec|popen|spawn)|shutil|socket|requests|urllib|http\.client|\bpty\b|multiprocessing|threading|eval\s*\(|exec\s*\(|__import__|open\s*\([^)]*['"][wa+]/

function allowSegment(seg) {
  const s = seg.trim()
  if (!s) return null
  if (/(^|\s)&(\s|$)/.test(s)) return null
  if (/&\s*$/.test(s)) return null // backgrounded execution stays in review
  if (/^(tail|head|wc|ls|cat|file|stat|which|command -v|echo|pwd|printenv|df|du|date|whoami|id|uname|hostname|cut|sort|uniq|tr|column|paste|diff|seq|dirname|basename|realpath|readlink|less|tree)(\s|$)/.test(s)) return "allowlist_read_only"
  if (/^rg(\s|$)/.test(s) && !/--pre\b/.test(s)) return "allowlist_search"
  if (/^grep(\s|$)/.test(s)) return "allowlist_search"
  if (/^sed\s+-n\s+(['"])[0-9,$]+p\1(\s+\S+\s*)?$/.test(s)) return "allowlist_search"
  if (/^node\s+--check(\s|$)/.test(s)) return "allowlist_node_check"
  if (/^just\s+(validate|test|check|lint|plan-summary|build)(\s|$)/.test(s) && !/--(justfile|working-directory|choose|chooser|completions|show|summary)\b/.test(s)) return "allowlist_just_recipe"
  if (/^nix\s+(flake\s+(check|show)|search|path-info)(\s|$)/.test(s)) return "allowlist_nix_read"
  if (/^python3\s+-m\s+(json\.tool|yaml)(\s|$)/.test(s)) return "allowlist_python_module"
  if (/^minions-tools\s+(auth\s+status|inspect|query)(\s|$)/.test(s)) return "allowlist_minions_read"
  if (/^tofu\s+plan(\s|$)/.test(s)) return "allowlist_tofu_plan"
  if (/^mkdir(\s|$)/.test(s)) {
    const tokens = tokenize(s).slice(1)
    let paths = 0
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]
      if (tok === "--") continue
      if (/^-[a-zA-Z]+$/.test(tok)) {
        if (!/^-[pmv]+$/.test(tok)) return null
        if (tok.includes("m")) i++ // -m consumes a mode value
        continue
      }
      if (!isTmpPath(tok)) return null
      paths++
    }
    if (paths > 0) return "allowlist_tmp_mkdir"
    return null
  }
  if (/^sqlite3(\s|$)/.test(s)) {
    const m = s.match(/^sqlite3\s+\S+\s+([\s\S]+)$/)
    if (!m) return null
    const rest = unquoteOnce(m[1])
    if (/^\s*(select\b|\.tables|\.schema)/i.test(rest) && !rest.includes(";")) return "allowlist_sqlite_read"
    return null
  }
  if (/^python3\s+-c=?(\s|$)/.test(s)) {
    const body = unquoteOnce(s.replace(/^python3\s+-c=?\s*/, "")).trim()
    if (/^(import\s+(json|yaml|sys)\b|from\s+(json|yaml)\s+import\b)/.test(body) && !PYTHON_FORBIDDEN.test(body)) {
      return "allowlist_filtered_python"
    }
    return null
  }
  return null
}

// Quote-aware command splitter: &&, ||, ;, newline, and | only split
// outside single/double quotes, so `python3 -c "a; b"` and `grep 'a|b'`
// stay whole instead of fragmenting into non-matching pieces.
function splitCommands(res) {
  const parts = []
  let cur = "", quote = null
  for (let i = 0; i < res.length; i++) {
    const ch = res[i]
    if (quote) {
      cur += ch
      if (ch === "\\" && i + 1 < res.length) cur += res[++i]
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if ((ch === "&" && res[i + 1] === "&") || (ch === "|" && res[i + 1] === "|")) {
      parts.push(cur)
      cur = ""
      i++
    } else if (ch === ";" || ch === "\n" || ch === "|") {
      parts.push(cur)
      cur = ""
    } else {
      cur += ch
    }
  }
  parts.push(cur)
  return parts.map((x) => x.trim()).filter(Boolean)
}

function allowResource(res) {
  const strippedRedirects = stripRedirects(res)
  if (strippedRedirects === null) return null
  const segments = splitCommands(strippedRedirects)
  if (segments.length === 0) return null
  let merge = null
  for (const seg of segments) {
    const code = allowSegment(seg)
    if (!code) return null
    merge = merge === null ? code : (merge === code ? merge : "allowlist_mixed")
  }
  return merge
}

// Returns a reasonCode when EVERY command resource is deterministically
// safe, else null (falls through to cache/model).
function allowlistReason(req, text) {
  if (process.env.OPENCODE_NO_ALLOWLIST === "1") return null
  if (!passesAllowGuards(text)) return null
  const resources = Array.isArray(req.resources) ? req.resources.filter((r) => typeof r === "string" && r.trim()) : []
  if (resources.length === 0) return null
  let merge = null
  for (const res of resources) {
    const code = allowResource(res)
    if (!code) return null
    merge = merge === null ? code : (merge === code ? merge : "allowlist_mixed")
  }
  return merge
}

const verdictCache = { entries: new Map(), loaded: false }

async function loadVerdictCache() {
  if (verdictCache.loaded) return
  verdictCache.loaded = true
  try {
    if (process.env.OPENCODE_NO_CACHE === "1") return
    const { readFile } = await import("node:fs/promises")
    const data = JSON.parse(await readFile(cachePath(), "utf8"))
    if (!data || data.version !== CACHE_VERSION || !Array.isArray(data.entries)) return
    const now = Date.now()
    for (const e of data.entries) {
      if (e && typeof e.key === "string" && (e.decision === "allow" || e.decision === "deny") && typeof e.ts === "number" && now - e.ts < CACHE_TTL_MS) {
        verdictCache.entries.set(e.key, e)
      }
    }
    while (verdictCache.entries.size > CACHE_MAX_ENTRIES) {
      verdictCache.entries.delete(verdictCache.entries.keys().next().value)
    }
  } catch {}
}

async function persistVerdictCache() {
  try {
    const { mkdir, writeFile } = await import("node:fs/promises")
    const { dirname } = await import("node:path")
    const path = cachePath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ version: CACHE_VERSION, entries: [...verdictCache.entries.values()].slice(-CACHE_MAX_ENTRIES) }), "utf8")
  } catch {}
}

function cacheKey(directory, text) {
  return `${directory || ""}\n${normalizeCommand(text)}`
}

function cacheGet(key) {
  const e = verdictCache.entries.get(key)
  if (!e) return null
  if (Date.now() - e.ts > CACHE_TTL_MS) {
    verdictCache.entries.delete(key)
    return null
  }
  return e
}

function cacheSet(key, decision, reasonCode, reason, model) {
  verdictCache.entries.delete(key)
  verdictCache.entries.set(key, { key, decision, reasonCode, reason: (reason || "").slice(0, 240), model, ts: Date.now() })
  while (verdictCache.entries.size > CACHE_MAX_ENTRIES) {
    verdictCache.entries.delete(verdictCache.entries.keys().next().value)
  }
  void persistVerdictCache()
}

// Test hook: pure helpers for node-based unit tests, attached to the plugin
// function below as AutoApprovePlugin.__test(). Kept out of module exports:
// the legacy plugin loader treats every named export as a plugin factory,
// so a second export breaks loading ("Plugin export is not a function").
const testHelpers = {
  parseModels,
  allowlistReason,
  allowResource,
  allowSegment,
  splitCommands,
  passesAllowGuards,
  stripRedirects,
  normalizeCommand,
  cacheKey,
  isStructuredOutputError,
  parseWhamQuotaPercent,
  quotaFloor,
}

function errorText(error) {
  if (error === null || error === undefined) return "unknown error"
  if (typeof error === "string") return error.slice(0, 500) || "unknown error"
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 500)
  try {
    const json = JSON.stringify(error)
    if (json && json !== "{}") return json.slice(0, 500)
  } catch {}
  const msg = error?.message
  if (typeof msg === "string" && msg) return msg.slice(0, 500)
  return Object.prototype.toString.call(error).slice(0, 200)
}

function isQuotaLike(error) {
  // Note: timeouts/aborts are NOT quota signals (they have their own
  // failureCategory); mislabeling them triggers wrong degraded toasts.
  // "unavailable" is deliberately absent: SDK shape errors ("current shape
  // unavailable") are not quota errors.
  const msg = errorText(error).toLowerCase()
  return /429|402|quota|rate.?limit|credit|insufficient|billing|exhausted|overloaded/.test(msg)
}

// ---- Quota floor: reserve the last OpenAI quota for the main agent ----
// Reads the same WHAM usage endpoint as the quota-watch TUI plugin. Cached
// in memory for OPENCODE_QUOTA_TTL_MS so permission asks stay fast; any
// fetch/parse failure returns undefined and the review proceeds normally.

const OPENAI_WHAM_URL = "https://chatgpt.com/backend-api/wham/usage"
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token"
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

const quotaFloorState = { percentLeft: undefined, fetchedAt: 0, inFlight: null }

function quotaFloor() {
  return numEnv("OPENCODE_QUOTA_FLOOR", 2, 0, 100)
}

function quotaTtlMs() {
  return numEnv("OPENCODE_QUOTA_TTL_MS", 60000, 5000, 600000)
}

function resolveAuthPath() {
  const base = process.env.XDG_DATA_HOME || `${process.env.HOME || "/tmp"}/.local/share`
  return `${base}/opencode/auth.json`
}

function parseWhamPercent(value) {
  const num = typeof value === "string" ? Number(value) : value
  return typeof num === "number" && Number.isFinite(num) ? num : undefined
}

// Most-restrictive window: smallest percent-left across all windows. The
// 5h window can be 100% used (provider hangs/rejects) while the weekly
// window still shows headroom — the floor must trigger in that state, so
// min() across windows, not the weekly view quota-watch displays.
function parseWhamQuotaPercent(body) {
  const rec = recordOf(body)
  const rl = recordOf(rec?.rate_limit)
  if (!rl) return undefined
  const lefts = [rl.primary_window, rl.secondary_window]
    .map((w) => parseWhamPercent(recordOf(w)?.used_percent))
    .filter((used) => used !== undefined)
    .map((used) => Math.max(0, 100 - Math.round(used)))
  if (lefts.length === 0) return undefined
  return Math.min(...lefts)
}

async function refreshOpenaiToken(refresh) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: OPENAI_CLIENT_ID,
  }).toString()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort("token refresh timed out"), 8000)
  try {
    const response = await fetch(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    const json = await response.json()
    return typeof recordOf(json)?.access_token === "string" ? json.access_token : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

async function fetchOpenaiQuotaPercent() {
  let entry
  try {
    const { readFile } = await import("node:fs/promises")
    const auth = JSON.parse(await readFile(resolveAuthPath(), "utf8"))
    entry = recordOf(recordOf(auth)?.openai)
  } catch {
    return undefined
  }
  const { access, accountId, refresh, expires } = entry ?? {}
  if (typeof access !== "string" || typeof accountId !== "string" || typeof refresh !== "string") {
    return undefined
  }
  let token = access
  if (typeof expires !== "number" || expires < Date.now() + 60_000) {
    token = (await refreshOpenaiToken(refresh)) ?? access
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort("quota fetch timed out"), 8000)
  try {
    const response = await fetch(OPENAI_WHAM_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "ChatGPT-Account-Id": accountId,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    return parseWhamQuotaPercent(await response.json())
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

async function getCachedOpenaiQuotaPercent() {
  const now = Date.now()
  if (quotaFloorState.percentLeft !== undefined && now - quotaFloorState.fetchedAt < quotaTtlMs()) {
    return quotaFloorState.percentLeft
  }
  if (!quotaFloorState.inFlight) {
    quotaFloorState.inFlight = fetchOpenaiQuotaPercent().then(
      (pct) => {
        if (pct !== undefined) {
          quotaFloorState.percentLeft = pct
          quotaFloorState.fetchedAt = Date.now()
        }
        quotaFloorState.inFlight = null
        return pct
      },
      () => {
        quotaFloorState.inFlight = null
        return undefined
      },
    )
  }
  return quotaFloorState.inFlight
}

const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "reasonCode", "reason"],
  properties: {
    decision: { type: "string", enum: ["allow", "deny"] },
    reasonCode: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
    reason: { type: "string", minLength: 1, maxLength: 240 },
  },
}

const REVIEWER_SESSION_PERMISSIONS = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "StructuredOutput", pattern: "*", action: "allow" },
]

function parseDecision(value) {
  let obj = value
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj)
    } catch {
      return null
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
  const { decision, reasonCode, reason } = obj
  if (decision !== "allow" && decision !== "deny") return null
  if (typeof reasonCode !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(reasonCode)) return null
  if (typeof reason !== "string" || !reason.trim() || reason.length > 240) return null
  return { decision, reasonCode, reason: reason.trim() }
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function unwrap(result) {
  let value = result
  for (let i = 0; i < 3 && value && typeof value === "object" && "data" in value; i++) value = value.data
  if (value && typeof value === "object" && value.error) throw value.error
  return value
}

// Reviewer session across SDK shapes. The stable shape ({path,query,body})
// goes first on runtimes exposing the legacy stable reply API, matching
// upstream's own dispatch. Throws an aggregated error; caller falls through.
async function reviewerGenerate(client, model, prompt, signal, location) {
  const session = client?.session
  if (!session) throw new Error("session API unavailable")
  const stable = typeof client?.postSessionIdPermissionsPermissionId === "function"
  const attempts = stable
    ? [generateStable, generateCurrent, generateV2]
    : [generateCurrent, generateV2, generateStable]
  const errors = []
  for (const attempt of attempts) {
    try {
      return await attempt(client, session, model, prompt, signal, location)
    } catch (error) {
      errors.push(errorText(error))
    }
  }
  throw new Error(errors.join(" | ") || "reviewer failed")
}

// Shape 1: current — session.create({title, agent, model}) + session.generate + session.remove
async function generateCurrent(client, session, model, prompt, signal, location) {
  if (typeof session.create !== "function" || typeof session.generate !== "function") {
    throw new Error("current shape unavailable")
  }
  let sessionID
  const abort = () => {
    if (sessionID && typeof session.interrupt === "function") {
      void Promise.resolve(session.interrupt({ sessionID })).catch(() => undefined)
    }
  }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    if (signal?.aborted) throw new Error("aborted")
    const created = await unwrap(
      await session.create({ title: "Auto-approve review", agent: REVIEWER_AGENT_ID, model, ...(location ? { location } : {}) }, { signal }),
    )
    const rec = recordOf(created)
    if (!rec || typeof rec.id !== "string") throw new Error("failed to create reviewer session")
    sessionID = rec.id
    const strict = `${prompt}\n\nReturn only one JSON object without fences with keys "decision" ("allow"|"deny"), "reasonCode" (lower_snake_case), "reason" (one sentence).`
    const result = await unwrap(await session.generate({ sessionID, prompt: strict }, { signal }))
    const rrec = recordOf(result)
    const text = typeof rrec?.text === "string" ? rrec.text : typeof result === "string" ? result : JSON.stringify(result)
    return JSON.parse(text)
  } finally {
    signal?.removeEventListener("abort", abort)
    if (sessionID && typeof session.remove === "function") {
      await Promise.resolve(session.remove({ sessionID })).catch(() => undefined)
    }
  }
}

// Shape 2: stable — session.create({query, body}) + session.prompt({path, query, body}) + session.delete
async function generateStable(client, session, model, prompt, signal, location) {
  if (typeof session.create !== "function" || typeof session.prompt !== "function") {
    throw new Error("stable shape unavailable")
  }
  const query = location ?? {}
  let sessionID
  const abortRemote = () => {
    if (sessionID && typeof session.abort === "function") {
      void Promise.resolve(session.abort({ path: { id: sessionID }, query })).catch(() => undefined)
    }
  }
  signal?.addEventListener("abort", abortRemote, { once: true })
  try {
    if (signal?.aborted) throw new Error("aborted")
    const created = await unwrap(
      await session.create({ query, body: { title: "Auto-approve review", permission: REVIEWER_SESSION_PERMISSIONS } }, { signal }),
    )
    const rec = recordOf(created)
    if (!rec || typeof rec.id !== "string") throw new Error("failed to create reviewer session")
    sessionID = rec.id
    const promptBody = {
      model: { providerID: model.providerID, modelID: model.id },
      ...(model.variant ? { variant: model.variant } : {}),
      agent: REVIEWER_AGENT_ID,
      format: { type: "json_schema", schema: DECISION_SCHEMA, retryCount: 1 },
      parts: [{ type: "text", text: prompt }],
    }
    try {
      const result = await unwrap(
        await session.prompt({ path: { id: sessionID }, query, body: promptBody }, { signal }),
      )
      return assistantStructured(result)
    } catch (error) {
      if (!isStructuredOutputError(error)) throw error
      const fallbackBody = {
        ...promptBody,
        format: { type: "text" },
        parts: [{
          type: "text",
          text: `${prompt}\n\nStructured output was unavailable. Return only one JSON object without Markdown fences with exactly: "decision" ("allow"|"deny"), "reasonCode" (lower_snake_case), "reason" (one sentence).`,
        }],
      }
      const result = await unwrap(
        await session.prompt({ path: { id: sessionID }, query, body: fallbackBody }, { signal }),
      )
      return JSON.parse(assistantText(result))
    }
  } finally {
    signal?.removeEventListener("abort", abortRemote)
    if (sessionID && typeof session.delete === "function") {
      await Promise.resolve(session.delete({ path: { id: sessionID }, query })).catch(() => undefined)
    }
  }
}

// Shape 3: v2 flat — session.create({...}) + session.prompt({sessionID, ...}) + session.delete
async function generateV2(client, session, model, prompt, signal, location) {
  if (typeof session.create !== "function" || typeof session.prompt !== "function") {
    throw new Error("v2 shape unavailable")
  }
  let sessionID
  try {
    if (signal?.aborted) throw new Error("aborted")
    const created = await unwrap(
      await session.create({ title: "Auto-approve review", agent: REVIEWER_AGENT_ID, model, ...(location || {}) }, { signal }),
    )
    const rec = recordOf(created)
    if (!rec || typeof rec.id !== "string") throw new Error("failed to create reviewer session")
    sessionID = rec.id
    const strict = `${prompt}\n\nReturn only one JSON object without fences with keys "decision" ("allow"|"deny"), "reasonCode", "reason".`
    const out = await unwrap(
      await session.prompt({ sessionID, ...(location || {}), model: { providerID: model.providerID, modelID: model.id }, agent: REVIEWER_AGENT_ID, parts: [{ type: "text", text: strict }] }, { signal }),
    )
    const orec = recordOf(out)
    if (orec && orec.info && typeof orec.info === "object" && "structured" in orec.info) return orec.info.structured
    const parts = Array.isArray(orec?.parts) ? orec.parts : []
    const text = parts.filter((p) => recordOf(p)?.type === "text").map((p) => p.text).join("").trim()
    if (!text) throw new Error("reviewer returned no text")
    return JSON.parse(text)
  } finally {
    if (sessionID && typeof session.delete === "function") {
      await Promise.resolve(session.delete({ sessionID, ...(location || {}) })).catch(() => undefined)
    }
  }
}

function assistantStructured(value) {
  const rec = recordOf(value)
  if (!rec) throw new Error("reviewer returned an invalid response")
  if (recordOf(rec.info)?.error) throw rec.info.error
  if (!recordOf(rec.info) || !("structured" in rec.info)) {
    throw new Error("reviewer returned no structured output")
  }
  return rec.info.structured
}

function assistantText(value) {
  const rec = recordOf(value)
  if (!rec) throw new Error("reviewer returned an invalid response")
  if (recordOf(rec.info)?.error) throw rec.info.error
  if (!Array.isArray(rec.parts)) throw new Error("reviewer returned no text output")
  const text = rec.parts
    .filter((part) => recordOf(part)?.type === "text")
    .map((part) => part.text)
    .filter((part) => typeof part === "string")
    .join("")
    .trim()
  if (!text) throw new Error("reviewer returned no text output")
  return text
}

const STRUCTURED_OUTPUT_HINTS = /structured.?output|json.?schema|response.?format|tool_choice|function choice|use_enum/i

function isStructuredOutputError(error, depth = 0) {
  if (depth > 4 || error === null || error === undefined) return false
  // Provider 400s arrive as Error objects whose message is a JSON string
  // (e.g. muse-spark: only `"auto"` is supported for `tool_choice`).
  if (typeof error === "string") {
    if (STRUCTURED_OUTPUT_HINTS.test(error)) return true
    try {
      return isStructuredOutputError(JSON.parse(error), depth + 1)
    } catch {
      return false
    }
  }
  if (!recordOf(error)) return false
  if (error.name === "StructuredOutputError" || error._tag === "StructuredOutputError") return true
  if (typeof error.message === "string" && STRUCTURED_OUTPUT_HINTS.test(error.message)) return true
  return (
    isStructuredOutputError(error.error, depth + 1) ||
    isStructuredOutputError(error.data, depth + 1) ||
    isStructuredOutputError(error.cause, depth + 1) ||
    isStructuredOutputError(error.message, depth + 1)
  )
}

// Permission reply across SDK shapes. Returns the shape name that worked.
// The generated SDK defaults to ThrowOnError=false, so HTTP 4xx/5xx resolve
// without throwing. A returned-but-failed reply must be treated as failure,
// otherwise "via: legacy-post" claims delivery that never happened.
function replyResultStatus(result) {
  const status = result?.response?.status ?? result?.status
  if (typeof status === "number") return status
  if (result?.error !== undefined && result?.error !== null) return -1
  return 200 // legacy void/undefined shape: assume delivered
}

function assertReplyDelivered(result, label) {
  const status = replyResultStatus(result)
  if (status === -1 || status < 200 || status >= 300) {
    let detail = ""
    try {
      detail = JSON.stringify(result?.error ?? result?.data ?? null)?.slice(0, 200) ?? ""
    } catch {}
    throw new Error(`${label} not delivered (status ${status}${detail ? `: ${detail}` : ""})`)
  }
  return status
}

async function replyToRequest(client, req, reply, message, directory) {
  const errors = []
  const body = { sessionID: req.sessionID, requestID: req.id, reply, ...(message ? { message } : {}) }
  try {
    if (typeof client?.permission?.reply === "function") {
      const result = await client.permission.reply(body)
      const status = assertReplyDelivered(result, "flat permission.reply")
      return `flat-permission.reply:${status}`
    }
    errors.push("flat:unavailable")
  } catch (error) {
    errors.push(`flat:${errorText(error).slice(0, 120)}`)
  }
  try {
    const scoped = client?.session?.permission ?? client?.v2?.session?.permission
    if (typeof scoped?.reply === "function") {
      const result = await scoped.reply(body)
      const status = assertReplyDelivered(result, "session.permission.reply")
      return `session.permission.reply:${status}`
    }
    errors.push("scoped:unavailable")
  } catch (error) {
    errors.push(`scoped:${errorText(error).slice(0, 120)}`)
  }
  try {
    if (typeof client?.postSessionIdPermissionsPermissionId === "function") {
      // Pending asks live in per-directory instance state: route the reply
      // with ?directory= first, then fall back to the unrouted call.
      const path = { id: req.sessionID, permissionID: req.id }
      const variants = []
      if (directory) variants.push({ path, body: { response: reply }, query: { directory } })
      variants.push({ path, body: { response: reply } })
      for (const args of variants) {
        try {
          const result = await client.postSessionIdPermissionsPermissionId(args)
          const status = assertReplyDelivered(result, "legacy-post")
          return `legacy-post:${status}${args.query ? ":dir" : ""}`
        } catch (error) {
          errors.push(`legacy${args.query ? "-dir" : ""}:${errorText(error).slice(0, 120)}`)
        }
      }
    } else {
      errors.push("legacy:unavailable")
    }
  } catch (error) {
    errors.push(`legacy:${errorText(error).slice(0, 120)}`)
  }
  void showToast(client, `Auto-approve could not resolve permission ${req.id} (${errors.join("; ").slice(0, 160)}) — manual approval needed.`)
  throw new Error(`no supported permission reply API (${errors.join("; ")})`)
}

async function getSessionModel(client, sessionID) {
  try {
    const session = client?.session
    if (!session || !sessionID) return undefined
    // Try session.get shapes.
    for (const args of [[{ path: { id: sessionID } }], [{ sessionID }], [sessionID]]) {
      try {
        if (typeof session.get !== "function") break
        const got = await unwrap(await session.get(...args))
        const rec = recordOf(got)
        const model = recordOf(rec?.model) || recordOf(rec?.info?.model)
        if (model && typeof model.providerID === "string") {
          const id = model.modelID ?? model.id
          if (typeof id === "string") return { providerID: model.providerID, id }
        }
        break
      } catch {}
    }
    // Try scanning recent messages for a model.
    for (const args of [[{ path: { id: sessionID }, query: { limit: 20 } }], [{ sessionID }]]) {
      try {
        if (typeof session.messages !== "function") break
        const list = await unwrap(await session.messages(...args))
        const arr = Array.isArray(list) ? list : list?.messages
        if (!Array.isArray(arr)) break
        for (let i = arr.length - 1; i >= 0; i--) {
          const m = recordOf(arr[i])
          const info = recordOf(m?.info) || m
          const model = recordOf(info?.model)
          if (model && typeof model.providerID === "string") {
            const id = model.modelID ?? model.id
            if (typeof id === "string") return { providerID: model.providerID, id }
          }
        }
        break
      } catch {}
    }
  } catch {}
  return undefined
}

// Mirror upstream: pin the resumed run to the latest user message's
// agent/model/variant. Without routing the forked run may never schedule.
function unwrapData(result) {
  let value = result?.data ?? result
  if (value && typeof value === "object" && !Array.isArray(value) && "data" in value) value = value.data
  return value
}

function latestUserRouting(messages) {
  if (!Array.isArray(messages)) return {}
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    const rec = recordOf(message)
    if (!rec) continue
    const info = recordOf(rec.info) ?? rec
    if (info.role !== "user") continue
    const routing = {}
    if (typeof info.agent === "string") routing.agent = info.agent
    const modelValue = recordOf(info.model)
    const providerID = modelValue?.providerID
    const modelID = modelValue?.modelID ?? modelValue?.id
    if (typeof providerID === "string" && typeof modelID === "string") {
      routing.model = { providerID, modelID }
      if (typeof modelValue?.variant === "string") routing.variant = modelValue.variant
    }
    return routing
  }
  return {}
}

// Mirror upstream waitForIdle: let the rejection teardown settle before
// prompting, so the resume starts a fresh run instead of colliding.
async function settleBeforeResume(client, directory, sessionID) {
  try {
    if (typeof client?.session?.status === "function") {
      for (let attempt = 0; attempt < 50; attempt++) {
        const statuses = unwrapData(await client.session.status(directory ? { query: { directory } } : {}))
        const state = recordOf(statuses?.[sessionID])
        if (!state || state.type === "idle") return "idle"
        await new Promise((r) => setTimeout(r, 100))
      }
      return "busy-timeout"
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 500))
  return "no-status-api"
}

// Best-effort: surface the denial reason to the coding agent so it can
// continue with a safer alternative instead of stalling. Every outcome is
// diagnosed by the caller: a silent resume is indistinguishable from a
// missing one (verified 2026-09-15: flat session.prompt throws
// "Expected a string starting with ses, got %7Bid%7D" on runtimes where
// prompt is the reviewer shape, so promptAsync comes first).
async function resumeAfterDenial(client, sessionID, reason, directory) {
  const text = `[Auto-approve] The requested action was blocked: ${reason} Do not retry the exact blocked action. Continue the task using a safer alternative when possible; ask the user only if no useful safe path remains.`
  const errors = []
  try {
    if (typeof client?.session?.promptAsync === "function") {
      let routing = {}
      try {
        if (typeof client?.session?.messages === "function") {
          const list = unwrapData(await client.session.messages({
            path: { id: sessionID },
            query: directory ? { directory, limit: 50 } : { limit: 50 },
          }))
          if (Array.isArray(list)) routing = latestUserRouting(list)
        }
      } catch (error) {
        errors.push(`messages:${errorText(error).slice(0, 80)}`)
      }
      const settled = await settleBeforeResume(client, directory, sessionID)
      const result = await client.session.promptAsync({
        path: { id: sessionID },
        ...(directory ? { query: { directory } } : {}),
        body: { ...routing, parts: [{ type: "text", text }] },
      })
      const status = assertReplyDelivered(result, "promptAsync")
      return `promptAsync:${status}:${settled}`
    }
    errors.push("promptAsync:unavailable")
  } catch (error) {
    errors.push(`promptAsync:${errorText(error).slice(0, 120)}`)
  }
  try {
    if (typeof client?.session?.prompt === "function") {
      const result = await client.session.prompt({ sessionID, text, resume: true })
      const status = assertReplyDelivered(result, "flat-session.prompt")
      return `flat-session.prompt:${status}`
    }
    errors.push("flat:unavailable")
  } catch (error) {
    errors.push(`flat:${errorText(error).slice(0, 120)}`)
  }
  try {
    if (typeof client?.v2?.session?.prompt === "function") {
      const result = await client.v2.session.prompt({ sessionID, prompt: { text }, delivery: "queue", resume: true })
      const status = assertReplyDelivered(result, "v2-session.prompt")
      return `v2-session.prompt:${status}`
    }
    errors.push("v2:unavailable")
  } catch (error) {
    errors.push(`v2:${errorText(error).slice(0, 120)}`)
  }
  throw new Error(`no supported session resume API (${errors.join("; ")})`)
}

function reportResume(client, sessionID, reason, directory, preview) {
  void resumeAfterDenial(client, sessionID, reason, directory).then(
    (via) => appendDiagnostic({ event: "resume_sent", via, preview }),
    (error) => {
      void appendDiagnostic({ event: "resume_failed", errorMessage: errorText(error), preview })
      void showToast(client, "Auto-approve blocked an action but could not notify the agent — check diagnostics.")
    },
  )
}

function clientCapabilities(client) {
  const caps = []
  const has = (path) => {
    const parts = path.split(".")
    let node = client
    for (const part of parts) {
      node = node?.[part]
      if (node === undefined || node === null) return false
    }
    return typeof node === "function"
  }
  for (
    const path of [
      "session.create",
      "session.generate",
      "session.prompt",
      "session.promptAsync",
      "session.remove",
      "session.delete",
      "session.get",
      "session.messages",
      "session.interrupt",
      "session.permission.reply",
      "v2.session.prompt",
      "v2.session.permission.reply",
      "permission.reply",
      "permission.request.list",
      "postSessionIdPermissionsPermissionId",
      "tui.showToast",
    ]
  ) {
    if (has(path)) caps.push(path)
  }
  return caps
}

export const AutoApprovePlugin = async ({ client, directory }) => {
  // Load marker + capability probe: proves the file was picked up at server
  // startup and shows which reply/generate shapes this runtime supports.
  void appendDiagnostic({ event: "plugin_loaded", capabilities: clientCapabilities(client) })
  const inFlight = new Set()

  async function reviewAndReply(req) {
    if (inFlight.has(req.id)) return
    inFlight.add(req.id)
    const startedAt = Date.now()
    const reviewDirectory = process.env.OPENCODE_REVIEW_DIR || directory || undefined
    const location = reviewDirectory ? { directory: reviewDirectory } : undefined
    try {
      const text = permissionText(req)
      const preview = text.slice(0, 120)

      // 1. Deterministic: catastrophic denies instantly, no model/quota burn.
      if (isCatastrophic(text)) {
        const reason = "Recursively deleting the filesystem root or home directory would cause catastrophic data loss; target only the specific generated directory instead."
        try {
          const via = await replyToRequest(client, req, "reject", `Auto-approve blocked this action: ${reason}`, reviewDirectory)
          reportResume(client, req.sessionID, reason, reviewDirectory, preview)
          void appendDiagnostic({ event: "decision", source: "policy", decision: "deny", reasonCode: "catastrophic", preview, via, elapsedMs: Date.now() - startedAt })
        } catch (error) {
          void appendDiagnostic({ event: "reply_failed", decision: "deny", errorMessage: errorText(error), preview })
        }
        return
      }

      // 1b. Deterministic allowlist: known-safe shapes resolve instantly,
      // no model/quota burn.
      await loadVerdictCache()
      const allowCode = allowlistReason(req, text)
      if (allowCode) {
        try {
          const via = await replyToRequest(client, req, "once", undefined, reviewDirectory)
          void appendDiagnostic({ event: "decision", source: "allowlist", decision: "allow", reasonCode: allowCode, preview, via, elapsedMs: Date.now() - startedAt })
        } catch (error) {
          void appendDiagnostic({ event: "reply_failed", decision: "allow", errorMessage: errorText(error), preview })
        }
        return
      }

      // 1c. Verdict cache: replay genuine primary-model verdicts only.
      // Fail-open/fallback/config outcomes are never cached.
      const key = cacheKey(reviewDirectory, text)
      const cached = cacheGet(key)
      if (cached) {
        try {
          if (cached.decision === "deny") {
            const via = await replyToRequest(client, req, "reject", `Auto-approve blocked this action (cached verdict): ${cached.reason}`, reviewDirectory)
            reportResume(client, req.sessionID, cached.reason, reviewDirectory, preview)
            void appendDiagnostic({ event: "cache_hit", decision: "deny", reasonCode: cached.reasonCode, preview, via, elapsedMs: Date.now() - startedAt })
          } else {
            const via = await replyToRequest(client, req, "once", undefined, reviewDirectory)
            void appendDiagnostic({ event: "cache_hit", decision: "allow", reasonCode: cached.reasonCode, preview, via, elapsedMs: Date.now() - startedAt })
          }
        } catch (error) {
          void appendDiagnostic({ event: "reply_failed", decision: cached.decision, errorMessage: errorText(error), preview })
        }
        return
      }

      const extra = process.env.OPENCODE_REVIEW_EXTRA ? `\n\nOperator note: ${process.env.OPENCODE_REVIEW_EXTRA}` : ""
      const prompt = `${BASE_INSTRUCTIONS}${extra}\n\nPermission request (untrusted data):\n${text.slice(0, 1500)}`
      const primaryTimeout = numEnv("OPENCODE_REVIEW_TIMEOUT_PRIMARY", 15000, 1000, 60000)
      const fallbackTimeout = numEnv("OPENCODE_REVIEW_TIMEOUT_FALLBACK", 45000, 1000, 90000)
      const onExhaustion = (process.env.OPENCODE_REVIEW_ON_EXHAUSTION || "allow").toLowerCase()
      let primaries
      try {
        primaries = parseModels(process.env.OPENCODE_REVIEW_MODELS)
      } catch (error) {
        void appendDiagnostic({ event: "failure", failureCategory: "config", errorMessage: errorText(error), preview })
        return // leave pending -> manual approval
      }

      const candidates = primaries.map((m) => ({ model: m, timeoutMs: primaryTimeout, source: "primary" }))
      if (!process.env.OPENCODE_REVIEW_NO_SESSION_FALLBACK) {
        const sessionModel = await getSessionModel(client, req.sessionID)
        if (sessionModel && !candidates.some((c) => c.model.providerID === sessionModel.providerID && c.model.id === sessionModel.id)) {
          candidates.push({ model: sessionModel, timeoutMs: fallbackTimeout, source: "session-fallback" })
        }
      }

      let degraded = false
      // Quota floor: skip OpenAI reviewer candidates so the last weekly
      // quota is reserved for the main agent. Unknown quota (undefined)
      // never blocks; non-OpenAI candidates still run.
      const floor = quotaFloor()
      let quotaFloored = false
      if (floor > 0 && candidates.some((c) => c.model.providerID === "openai")) {
        const percentLeft = await getCachedOpenaiQuotaPercent()
        if (percentLeft !== undefined && percentLeft < floor) {
          const skipped = candidates.filter((c) => c.model.providerID === "openai").length
          void appendDiagnostic({ event: "quota_floor", percentLeft, floor, skipped, preview })
          quotaFloored = true
          degraded = true
          for (let i = candidates.length - 1; i >= 0; i--) {
            if (candidates[i].model.providerID === "openai") candidates.splice(i, 1)
          }
          if (candidates.length === 0) {
            void showToast(client, `OpenAI quota ${percentLeft}% — reviewer paused (${onExhaustion === "manual" ? "manual approval" : onExhaustion === "deny" ? "blocking" : "auto-approve"}).`)
          } else {
            void showToast(client, `OpenAI quota ${percentLeft}% — reviewer paused (non-OpenAI fallback only).`)
          }
        }
      }
      for (const { model, timeoutMs, source } of candidates) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort("review timed out"), timeoutMs)
        try {
          const raw = await withTimeout(reviewerGenerate(client, model, prompt, controller.signal, location), timeoutMs + 2000, "Permission review timed out")
          const decision = parseDecision(raw)
          if (!decision) throw new Error("Reviewer returned an invalid decision")
          if (source === "primary" && !degraded) {
            cacheSet(key, decision.decision, decision.reasonCode, decision.reason, `${model.providerID}/${model.id}`)
          }
          if (decision.decision === "deny") {
            try {
              const via = await replyToRequest(client, req, "reject", `Auto-approve blocked this action: ${decision.reason}`, reviewDirectory)
              reportResume(client, req.sessionID, decision.reason, reviewDirectory, preview)
              void appendDiagnostic({
                event: "decision", source: `model:${source}`, model: `${model.providerID}/${model.id}`,
                decision: "deny", reasonCode: decision.reasonCode, preview, via, degraded, elapsedMs: Date.now() - startedAt,
              })
            } catch (error) {
              void appendDiagnostic({ event: "reply_failed", decision: "deny", errorMessage: errorText(error), preview })
            }
          } else {
            try {
              const via = await replyToRequest(client, req, "once", undefined, reviewDirectory)
              void appendDiagnostic({
                event: "decision", source: `model:${source}`, model: `${model.providerID}/${model.id}`,
                decision: "allow", reasonCode: decision.reasonCode, preview, via, degraded, elapsedMs: Date.now() - startedAt,
              })
            } catch (error) {
              void appendDiagnostic({ event: "reply_failed", decision: "allow", errorMessage: errorText(error), preview })
            }
          }
          if (degraded && !quotaFloored) void showToast(client, "Primary reviewer degraded — used fallback model.")
          return
        } catch (error) {
          const quotaLike = isQuotaLike(error)
          degraded = degraded || quotaLike || source !== "primary"
          void appendDiagnostic({
            event: "failure", model: `${model.providerID}/${model.id}`, source,
            failureCategory: /timed out/i.test(errorText(error)) ? "timeout" : quotaLike ? "quota" : "error",
            errorMessage: errorText(error), preview, elapsedMs: Date.now() - startedAt,
          })
          if (quotaLike && source === "primary") void showToast(client, `Primary reviewer unavailable (${model.id}) — trying fallback.`)
          continue
        } finally {
          clearTimeout(timer)
        }
      }

      // 2. All models exhausted. Fail-open for everything non-catastrophic
      // (catastrophic already returned above). When the quota floor caused
      // this, the floor toast above already explained; don't double-toast.
      if (!quotaFloored) void showToast(client, "Reviewer unavailable — auto-approved (non-destructive).")
      void appendDiagnostic({ event: "exhausted", onExhaustion, quotaFloored, preview, elapsedMs: Date.now() - startedAt })
      if (onExhaustion === "deny") {
        try {
          await replyToRequest(client, req, "reject", "Auto-approve blocked this action: reviewer unavailable.", reviewDirectory)
        } catch (error) {
          void appendDiagnostic({ event: "reply_failed", decision: "deny", errorMessage: errorText(error), preview })
        }
        return
      }
      if (onExhaustion === "manual") return // leave pending -> TUI manual approval
      try {
        const via = await replyToRequest(client, req, "once", undefined, reviewDirectory)
        void appendDiagnostic({ event: "decision", source: "exhausted-fail-open", decision: "allow", preview, via })
      } catch (error) {
        void appendDiagnostic({ event: "reply_failed", decision: "allow", errorMessage: errorText(error), preview })
      }
    } finally {
      inFlight.delete(req.id)
    }
  }

  return {
    // Register hidden, no-tool reviewer agent. Best-effort: ignored on runtimes
    // without agent config support; reviewer sessions still carry no tools.
    config: async (input) => {
      try {
        input.agent ??= {}
        input.agent[REVIEWER_AGENT_ID] = {
          description: "Hidden permission reviewer for auto-approve.",
          mode: "subagent",
          hidden: true,
          steps: 1,
          tools: { "*": false },
          permission: { "*": "deny" },
          prompt: BASE_INSTRUCTIONS,
        }
      } catch {}
    },

    // Logging-only stub: this hook is declared but never fired by the engine
    // (verified 2026-09-15). If it ever fires, the diagnostic below reveals it.
    "permission.ask": async (input, _output) => {
      void appendDiagnostic({ event: "hook_fired", permission: input?.type ?? input?.permission ?? "unknown" })
    },

    event: async ({ event }) => {
      try {
        if (event?.type === "permission.asked" || event?.type === "permission.v2.asked") {
          const req = normalizeRequest(event.properties ?? event.data)
          if (!req) {
            void appendDiagnostic({ event: "unrecognized", type: event.type })
            return
          }
          req.eventType = event.type
          void appendDiagnostic({ event: "received", eventType: event.type, id: req.id, preview: permissionText(req).slice(0, 120) })
          await reviewAndReply(req)
        } else if (event?.type === "permission.replied" || event?.type === "permission.v2.replied") {
          const payload = event.properties ?? event.data
          const rid = payload?.requestID ?? payload?.permissionID ?? payload?.id
          if (typeof rid === "string") inFlight.delete(rid)
          void appendDiagnostic({ event: "replied", eventType: event.type, id: typeof rid === "string" ? rid : "unknown" })
        } else if (typeof event?.type === "string" && event.type.startsWith("permission.")) {
          void appendDiagnostic({ event: "skipped", type: event.type })
        }
      } catch (error) {
        void appendDiagnostic({ event: "hook_error", errorMessage: errorText(error) })
      }
    },
  }
}

// Single module export (see note on testHelpers above). Test seam for
// node-based unit tests: `import { AutoApprovePlugin }` then call
// `AutoApprovePlugin.__test()` to reach the pure helpers.
AutoApprovePlugin.__test = () => testHelpers
