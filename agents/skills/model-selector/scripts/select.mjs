#!/usr/bin/env node

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { answerChoice, requestJev } from "../../../opencode/plugins/lib/jev-client.js"

const here = dirname(fileURLToPath(import.meta.url))
const profiles = JSON.parse(await readFile(join(here, "..", "profiles.json"), "utf8"))
const maxBriefChars = 8_000
const maxCacheAgeMs = 3 * 60_000

function quotaCachePath() {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode", "quota-watch.json")
}

async function quotaState() {
  try {
    const cached = JSON.parse(await readFile(quotaCachePath(), "utf8"))
    if (typeof cached.generatedAt !== "number" || Date.now() - cached.generatedAt > maxCacheAgeMs) return undefined
    return cached
  } catch {
    return undefined
  }
}

function openaiQuotaLow(quota) {
  const openai = quota?.openai
  return openai && (openai.hourly?.percentLeft < 20 || openai.percentLeft < 10)
}

function selectionCriteria(quota) {
  const low = openaiQuotaLow(quota)
  const candidates = {
    quick: profiles.quick.description,
    [low ? "workhorse-zai" : "workhorse"]: profiles[low ? "workhorse-zai" : "workhorse"].description,
    deep: profiles.deep.description,
  }
  return candidates
}

export async function selectModel(brief, { quota, request = requestJev } = {}) {
  quota ??= await quotaState()
  const criteria = selectionCriteria(quota)
  try {
    const response = await request({
      state: {
        remaining_work: brief.slice(0, maxBriefChars),
        quota: quota ?? "Unavailable. Do not make quota assumptions; choose by task fit.",
      },
      questions: {
        profile: {
          type: "choice",
          instructions: "Which execution profile best fits the remaining work? Choose the cheapest profile that is sufficient. A long task with a credible plan is workhorse work, not deep work. Quota is current resource context: if OpenAI quota is low, the workhorse-zai option preserves it; deep remains available only for genuinely hard decisions.",
          criteria,
        },
      },
      timeoutMs: 3_000,
    })
    const answer = answerChoice(response.answers?.profile)
    if (!answer || !Object.hasOwn(profiles, answer.choice) || !Object.hasOwn(criteria, answer.choice)) throw new Error("invalid Jev profile response")
    const profile = profiles[answer.choice]
    return { ...profile, profile: answer.choice, confidence: answer.confidence, quota, source: "jev" }
  } catch (error) {
    const profile = profiles[openaiQuotaLow(quota) ? "workhorse-zai" : "workhorse"]
    return { ...profile, profile: openaiQuotaLow(quota) ? "workhorse-zai" : "workhorse", quota, source: "fallback", error: String(error) }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const result = await selectModel(Buffer.concat(chunks).toString("utf8"))
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
