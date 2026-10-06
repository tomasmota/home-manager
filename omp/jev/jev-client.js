export const TYPESAFE_API_URL = "https://api.typesafe.ai/v1/systemone"

export function recordOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null
}

export function numberEnv(name, fallback, min, max, env = process.env) {
  const value = Number(env[name])
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

export function answerScore(value) {
  const rec = recordOf(value)
  if (rec?.type !== "score" || !Number.isFinite(rec.score) || !Number.isFinite(rec.confidence)) return null
  return { score: rec.score, confidence: rec.confidence, probabilities: recordOf(rec.probabilities) ?? {} }
}

export function answerNoul(value) {
  const rec = recordOf(value)
  return rec?.type === "noul" && Number.isFinite(rec.noul) ? rec.noul : null
}

export function answerChoice(value) {
  const rec = recordOf(value)
  if (rec?.type !== "choice" || typeof rec.choice !== "string" || !Number.isFinite(rec.confidence)) return null
  return { choice: rec.choice, confidence: rec.confidence, probabilities: recordOf(rec.probabilities) ?? {} }
}

// OpenCode can be launched from contexts that never source the shell env
// (GUI, launchd, detached serve processes), so plugins miss secrets sourced by
// zsh. Parse the same env-style secrets file as a fallback.
let secretsEnvByPath = new Map()

export async function loadSecretsEnv(
  path = process.env.OPENCODE_SECRETS_FILE || `${process.env.HOME || ""}/.config/home-manager/secrets.env`,
) {
  const cached = secretsEnvByPath.get(path)
  if (cached) return cached
  const values = {}
  try {
    const { readFile } = await import("node:fs/promises")
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
      if (!match) continue
      values[match[1]] = unquote(match[2])
    }
  } catch {}
  secretsEnvByPath.set(path, values)
  return values
}

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function retryDelay(response) {
  const raw = response.headers.get("retry-after")
  if (!raw) return 200
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.min(1000, Math.max(0, seconds * 1000))
  const date = Date.parse(raw)
  return Number.isFinite(date) ? Math.min(1000, Math.max(0, date - Date.now())) : 200
}

export async function requestJev({
  state,
  questions,
  apiKey,
  model = process.env.OPENCODE_JEV_MODEL || "jev-latest",
  timeoutMs = 5000,
  fetchFn = globalThis.fetch,
}) {
  const key = apiKey ?? process.env.TYPESAFE_API_KEY ?? (await loadSecretsEnv()).TYPESAFE_API_KEY
  if (!key) throw new Error("TYPESAFE_API_KEY is not set")
  if (typeof fetchFn !== "function") throw new Error("fetch is unavailable")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort("Jev request timed out"), timeoutMs)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetchFn(TYPESAFE_API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, state, questions }),
        signal: controller.signal,
      })
      if ((response.status === 429 || response.status === 529) && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay(response)))
        continue
      }
      if (!response.ok) throw new Error(`Jev HTTP ${response.status}`)
      return response.json()
    }
    throw new Error("Jev retry exhausted")
  } finally {
    clearTimeout(timer)
  }
}
