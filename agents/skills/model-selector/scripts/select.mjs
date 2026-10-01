#!/usr/bin/env node

import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { answerChoice, requestJev } from "../../../opencode/lib/jev-client.js"
import { loadRoutes, parseModelRef, primaryAgents, readState } from "../../../opencode/lib/agent-routes.js"

const maxBriefChars = 8_000
const defaultAgent = "general"

// The agent-routes plugin's state holds each agent's model after quota fallbacks;
// without fresh state, the configured model is used.
export function resolveAgent(routes, id, state) {
  const agent = routes.agents[id]
  if (!agent) throw new Error(`unknown agent: ${id}`)
  const live = state?.agents?.[id]
  const ref = parseModelRef(live?.model ?? agent.model)
  return {
    agent: id,
    model: `${ref.providerID}/${ref.id}`,
    ...(ref.variant ? { effort: ref.variant } : {}),
    ...(live?.fallbackFrom ? { fallbackFrom: live.fallbackFrom } : {}),
  }
}

export async function selectModel(brief, { routes, state, request = requestJev } = {}) {
  routes ??= await loadRoutes()
  state ??= await readState()
  const criteria = Object.fromEntries(primaryAgents(routes).map((agent) => [agent.id, agent.description]))
  try {
    const response = await request({
      state: { remaining_work: brief.slice(0, maxBriefChars) },
      questions: {
        agent: {
          type: "choice",
          instructions: `Which agent should run the remaining work? Match the work against each agent's description. Choose ${defaultAgent} when no other agent clearly fits.`,
          criteria,
        },
      },
      timeoutMs: 3_000,
    })
    const answer = answerChoice(response.answers?.agent)
    if (!answer || !Object.hasOwn(criteria, answer.choice)) throw new Error("invalid Jev agent response")
    return { ...resolveAgent(routes, answer.choice, state), confidence: answer.confidence, source: "jev" }
  } catch (error) {
    return { ...resolveAgent(routes, defaultAgent, state), source: "fallback", error: String(error) }
  }
}

const isCli = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  const named = process.argv.indexOf("--agent")
  let result
  if (named !== -1) {
    result = resolveAgent(await loadRoutes(), process.argv[named + 1], await readState())
  } else {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    result = await selectModel(Buffer.concat(chunks).toString("utf8"))
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
