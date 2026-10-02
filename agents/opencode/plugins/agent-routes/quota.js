import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { fetchOpenaiQuota } from "../../tui-plugins/quota-watch/src/openaiQuota.ts"

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
const CLAUDE_AUTH_DIR = join(homedir(), ".local", "share", "cliproxyapi", "auth")
const QUOTA_WATCH_MAX_AGE_MS = 10 * 60_000

function cacheDir(env = process.env) {
  return join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode")
}

// The OpenCode service may not inherit the login shell's PATH.
function codexCommand() {
  const candidates = [
    join(homedir(), ".local", "bin", "codex"),
    `/etc/profiles/per-user/${userInfo().username}/bin/codex`,
    "/run/current-system/sw/bin/codex",
    "/opt/homebrew/bin/codex",
  ]
  return candidates.find((path) => existsSync(path)) ?? "codex"
}

// Reuse the TUI's reading while it is fresh instead of spawning codex again.
async function openaiFromQuotaWatch(now) {
  try {
    const cached = JSON.parse(await readFile(join(cacheDir(), "quota-watch.json"), "utf8"))
    if (!cached?.openai || !(now - cached.generatedAt <= QUOTA_WATCH_MAX_AGE_MS)) return undefined
    return { weeklyLeft: cached.openai.percentLeft, fiveHourLeft: cached.openai.hourly?.percentLeft, checkedAt: cached.generatedAt }
  } catch {
    return undefined
  }
}

export async function fetchOpenai(now = Date.now()) {
  const cached = await openaiFromQuotaWatch(now)
  if (cached) return cached
  const quota = await fetchOpenaiQuota(codexCommand())
  if (!quota) return undefined
  return { weeklyLeft: quota.percentLeft, fiveHourLeft: quota.hourly?.percentLeft, checkedAt: Date.now() }
}

// CLIProxyAPI owns the token lifecycle; only read its current access token, never refresh it.
async function claudeAccessToken(dir = CLAUDE_AUTH_DIR) {
  for (const file of (await readdir(dir)).filter((name) => name.startsWith("claude-") && name.endsWith(".json"))) {
    let auth
    try {
      auth = JSON.parse(await readFile(join(dir, file), "utf8"))
    } catch {
      continue
    }
    if (auth?.type !== "claude" || auth.disabled || typeof auth.access_token !== "string") continue
    if (auth.expired && Date.parse(auth.expired) <= Date.now()) continue
    return auth.access_token
  }
  return undefined
}

function percentLeft(window) {
  return Number.isFinite(window?.utilization) ? Math.max(0, Math.round(100 - window.utilization)) : undefined
}

export function parseClaudeUsage(usage, now = Date.now()) {
  const fiveHourLeft = percentLeft(usage?.five_hour)
  const weeklyLeft = percentLeft(usage?.seven_day)
  if (fiveHourLeft === undefined && weeklyLeft === undefined) return undefined
  return { fiveHourLeft, weeklyLeft, checkedAt: now }
}

export async function fetchClaude({ fetchFn = globalThis.fetch, authDir = CLAUDE_AUTH_DIR } = {}) {
  const token = await claudeAccessToken(authDir).catch(() => undefined)
  if (!token) return undefined
  const response = await fetchFn(CLAUDE_USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    const error = new Error(`Claude usage HTTP ${response.status}`)
    const retryAfter = Number(response.headers.get("retry-after"))
    if (response.status === 429) error.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RATE_LIMIT_BACKOFF_MS
    throw error
  }
  return parseClaudeUsage(await response.json())
}

// Keys are OpenCode provider IDs, matching `fallbacks` in subagents.jsonc.
export const QUOTA_SOURCES = {
  openai: fetchOpenai,
  "claude-subscription": fetchClaude,
}

const RATE_LIMIT_BACKOFF_MS = 15 * 60_000
export { fetchQuotaShared, resetSharedQuota } from "../../lib/quota-cache.js"
