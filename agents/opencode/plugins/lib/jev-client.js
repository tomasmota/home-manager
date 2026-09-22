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
  apiKey = process.env.TYPESAFE_API_KEY,
  model = process.env.OPENCODE_JEV_MODEL || "jev-latest",
  timeoutMs = 5000,
  fetchFn = globalThis.fetch,
}) {
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set")
  if (typeof fetchFn !== "function") throw new Error("fetch is unavailable")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort("Jev request timed out"), timeoutMs)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetchFn(TYPESAFE_API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
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
