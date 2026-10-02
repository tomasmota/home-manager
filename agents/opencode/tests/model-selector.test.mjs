import assert from "node:assert/strict"
import test from "node:test"

import { resolveAgent, selectModel } from "../../skills/model-selector/scripts/select.mjs"
import { loadRoutes, validateRoutes } from "../lib/agent-routes.js"

const { routes } = validateRoutes({
  agents: {
    general: { mode: "all", model: "claude-subscription/claude-sonnet-5-5#high", description: "Default." },
    terminal: { mode: "all", model: "openai/gpt-6.1-sol#xhigh", description: "Shell work." },
    explore: { model: "inco/glm-5.3-flash:fast", description: "Search." },
  },
})
const openaiLow = {
  agents: { terminal: { model: "claude-subscription/claude-opus-5-5#xhigh", fallbackFrom: "openai/gpt-6.1-sol#xhigh" } },
}

test("offers only primary-capable agents to Jev", async () => {
  const result = await selectModel("Investigate the cluster.", {
    routes,
    state: {},
    request: async ({ questions }) => {
      assert.deepEqual(Object.keys(questions.agent.criteria), ["general", "terminal"])
      return { answers: { agent: { type: "choice", choice: "terminal", confidence: 0.9 } } }
    },
  })
  assert.deepEqual(
    { agent: result.agent, model: result.model, effort: result.effort, source: result.source },
    { agent: "terminal", model: "openai/gpt-6.1-sol", effort: "xhigh", source: "jev" },
  )
})

test("uses the plugin's fallback model for the chosen agent", async () => {
  const result = await selectModel("Investigate the cluster.", {
    routes,
    state: openaiLow,
    request: async () => ({ answers: { agent: { type: "choice", choice: "terminal", confidence: 0.9 } } }),
  })
  assert.equal(result.model, "claude-subscription/claude-opus-5-5")
  assert.equal(result.effort, "xhigh")
  assert.equal(result.fallbackFrom, "openai/gpt-6.1-sol#xhigh")
})

test("falls back to general when Jev is unavailable", async () => {
  const result = await selectModel("Anything.", {
    routes,
    state: {},
    request: async () => {
      throw new Error("unavailable")
    },
  })
  assert.equal(result.agent, "general")
  assert.equal(result.source, "fallback")
})

test("resolves a named agent without Jev", () => {
  assert.deepEqual(resolveAgent(routes, "general", undefined), {
    agent: "general",
    model: "claude-subscription/claude-sonnet-5-5",
    effort: "high",
  })
  assert.deepEqual(resolveAgent(routes, "explore", undefined), { agent: "explore", model: "inco/glm-5.3-flash:fast" })
  assert.throws(() => resolveAgent(routes, "missing", undefined), /unknown agent/)
})

test("the tracked subagents.jsonc is valid", async () => {
  const tracked = await loadRoutes(new URL("../subagents.jsonc", import.meta.url))
  assert.ok(tracked.agents.general)
  assert.ok(tracked.agents.explore)
})
