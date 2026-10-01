import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  effectiveModel,
  evaluateRules,
  formatModelRef,
  freshQuota,
  lowProviders,
  parseJsonc,
  parseModelRef,
  readState,
  validateRoutes,
  wildcardMatch,
} from "../lib/agent-routes.js"
import { fetchClaude, fetchQuotaShared, parseClaudeUsage, resetSharedQuota } from "../plugins/agent-routes/quota.js"

test("parses JSONC comments and trailing commas without touching strings", () => {
  const parsed = parseJsonc(`{
    // line comment
    "url": "http://example.com/a//b", /* block */
    "text": "has \\" quote, and /* not a comment */",
    "list": [1, 2,],
  }`)
  assert.deepEqual(parsed, { url: "http://example.com/a//b", text: 'has " quote, and /* not a comment */', list: [1, 2] })
  assert.deepEqual(parseJsonc('{ "keep": "a ,} and ,]", "list": [1, // trailing\n], }'), { keep: "a ,} and ,]", list: [1] })
})

test("parses model refs with colons and variants", () => {
  assert.deepEqual(parseModelRef("inco/glm-5.3-flash:fast"), { providerID: "inco", id: "glm-5.3-flash:fast" })
  assert.deepEqual(parseModelRef("openai/gpt-6.1-sol#xhigh"), { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" })
  assert.equal(parseModelRef("no-provider"), null)
  assert.equal(parseModelRef("openai/gpt#"), null)
  assert.equal(formatModelRef({ providerID: "openai", id: "gpt-6.1-sol", variant: "high" }), "openai/gpt-6.1-sol#high")
})

test("validates agents and merges shared permissions first", () => {
  const { errors, routes } = validateRoutes({
    permissions: [{ action: "subagent", resource: "*", effect: "deny", when: "child" }],
    agents: {
      reviewer: {
        model: "openai/gpt-5.6-sol#medium",
        description: "Reviews.",
        system: ["line one", "line two"],
        permissions: [{ action: "edit", resource: "*", effect: "deny" }],
      },
    },
  })
  assert.deepEqual(errors, [])
  assert.equal(routes.agents.reviewer.mode, "subagent")
  assert.equal(routes.agents.reviewer.system, "line one\nline two")
  assert.deepEqual(
    routes.agents.reviewer.permissions.map((rule) => rule.action),
    ["subagent", "edit"],
  )
})

test("reports invalid entries and leaves invalid agents out", () => {
  const { errors, routes } = validateRoutes({
    fallbacks: { openai: "bad" },
    typo: true,
    agents: {
      broken: { model: "bad", mode: "nope", variant: "high", permissions: [{ action: "edit" }] },
      fine: { model: "openai/gpt-6.1-sol", description: "Fine." },
    },
  })
  assert.equal(errors.length, 7)
  assert.deepEqual(Object.keys(routes.agents), ["fine"])
})

test("detects low providers below either threshold", () => {
  const low = lowProviders(
    { openai: { fiveHourLeft: 19, weeklyLeft: 80 }, claude: { fiveHourLeft: 90, weeklyLeft: 9 }, inco: { weeklyLeft: 50 } },
    { fiveHour: 20, weekly: 10 },
  )
  assert.deepEqual([...low].sort(), ["claude", "openai"])
})

test("falls back without chaining and keeps supported variants", () => {
  const fallbacks = { openai: "claude-subscription/claude-opus-5-5", "claude-subscription": "openai/gpt-6.1-sol#high" }
  const variantsOf = (model) => (model === "claude-subscription/claude-opus-5-5" ? ["low", "high", "xhigh"] : undefined)

  assert.deepEqual(effectiveModel("openai/gpt-6.1-sol#xhigh", { fallbacks, low: new Set(["openai"]), variantsOf }), {
    model: "claude-subscription/claude-opus-5-5#xhigh",
    fallbackFrom: "openai/gpt-6.1-sol#xhigh",
  })
  assert.equal(
    effectiveModel("openai/gpt-5.6-sol#none", { fallbacks, low: new Set(["openai"]), variantsOf }).model,
    "claude-subscription/claude-opus-5-5",
  )
  assert.equal(
    effectiveModel("claude-subscription/claude-opus-5-5#xhigh", { fallbacks, low: new Set(["claude-subscription"]) }).model,
    "openai/gpt-6.1-sol#high",
  )
  assert.deepEqual(effectiveModel("openai/gpt-6.1-sol#xhigh", { fallbacks, low: new Set(["openai", "claude-subscription"]) }), {
    model: "openai/gpt-6.1-sol#xhigh",
  })
  assert.deepEqual(effectiveModel("inco/glm-5.3-flash:fast", { fallbacks, low: new Set(["inco"]) }), {
    model: "inco/glm-5.3-flash:fast",
  })
})

test("falls back when a provider is not configured on this machine", () => {
  const fallbacks = { "claude-subscription": "openai/gpt-6.1-sol#high" }
  const unavailable = (model) => model.startsWith("claude-subscription/")
  assert.equal(
    effectiveModel("claude-subscription/claude-sonnet-5-5#high", { fallbacks, low: new Set(), unavailable }).model,
    "openai/gpt-6.1-sol#high",
  )
  assert.equal(effectiveModel("openai/gpt-6.1-sol#xhigh", { fallbacks, low: new Set(), unavailable }).model, "openai/gpt-6.1-sol#xhigh")
})

test("matches wildcards like OpenCode", () => {
  assert.ok(wildcardMatch("explore", "*"))
  assert.ok(wildcardMatch("explore", "explore"))
  assert.ok(!wildcardMatch("explorer", "explore"))
  assert.ok(wildcardMatch("ls", "ls *"))
  assert.ok(wildcardMatch("ls -la", "ls *"))
  assert.ok(wildcardMatch("x.env", "*.env"))
})

test("evaluates scoped rules with last match winning", () => {
  const rules = [
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "subagent", resource: "explore", effect: "allow" },
  ]
  assert.equal(evaluateRules(rules, "subagent", ["explore"], "allow"), "allow")
  assert.equal(evaluateRules(rules, "subagent", ["coder"], "allow"), "deny")
  assert.equal(evaluateRules(rules, "subagent", ["explore", "coder"], "allow"), "deny")
  assert.equal(evaluateRules(rules, "edit", ["file.ts"], "allow"), undefined)
  assert.equal(evaluateRules([{ action: "read", resource: "a", effect: "allow" }], "read", ["a", "b"], "ask"), "ask")
})

test("reads fresh state and drops stale quota", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-routes-"))
  const path = join(dir, "agent-routes.json")
  const now = 1_000_000_000
  await writeFile(path, JSON.stringify({ updatedAt: now - 60_000, agents: { general: { model: "a/b" } } }))
  assert.equal((await readState({ path, now })).agents.general.model, "a/b")
  assert.equal(await readState({ path, now: now + 60 * 60_000 }), undefined)
  assert.equal(await readState({ path: join(dir, "missing.json"), now }), undefined)
  assert.deepEqual(
    Object.keys(
      freshQuota(
        { openai: { weeklyLeft: 5, checkedAt: now - 60_000 }, "claude-subscription": { weeklyLeft: 5, checkedAt: now - 60 * 60_000 } },
        { now },
      ),
    ),
    ["openai"],
  )
})

test("parses Claude usage utilization into percent left", () => {
  assert.deepEqual(parseClaudeUsage({ five_hour: { utilization: 10.4 }, seven_day: { utilization: 79 } }, 5), {
    fiveHourLeft: 90,
    weeklyLeft: 21,
    checkedAt: 5,
  })
  assert.equal(parseClaudeUsage({ five_hour: null }), undefined)
})

test("shares in-flight quota fetches and backs off after a rate limit", async () => {
  resetSharedQuota()
  let calls = 0
  const fresh = { weeklyLeft: 50, checkedAt: Date.now() }
  const slow = async () => {
    calls++
    await new Promise((resolve) => setTimeout(resolve, 20))
    return fresh
  }
  const [a, b] = await Promise.all([
    fetchQuotaShared("p", slow, { maxAgeMs: 60_000 }),
    fetchQuotaShared("p", slow, { maxAgeMs: 60_000 }),
  ])
  assert.equal(calls, 1)
  assert.equal(a, fresh)
  assert.equal(b, fresh)

  assert.equal(await fetchQuotaShared("p", slow, { cached: fresh, maxAgeMs: 60_000 }), fresh)
  assert.equal(calls, 1)

  const limited = Object.assign(new Error("HTTP 429"), { retryAfterMs: 60_000 })
  await assert.rejects(
    fetchQuotaShared("q", async () => {
      calls++
      throw limited
    }, { maxAgeMs: 0 }),
    /429/,
  )
  const stale = { weeklyLeft: 40, checkedAt: 0 }
  assert.equal(await fetchQuotaShared("q", slow, { cached: stale, maxAgeMs: 0 }), stale)
  assert.equal(calls, 2)
  resetSharedQuota()
})

test("skips unreadable Claude auth files and reads only the access token", async () => {
  const authDir = await mkdtemp(join(tmpdir(), "agent-routes-auth-"))
  const future = new Date(Date.now() + 3_600_000).toISOString()
  await writeFile(join(authDir, "claude-a.json"), "{ not json")
  await writeFile(join(authDir, "claude-b.json"), JSON.stringify({ type: "claude", disabled: true, access_token: "off", expired: future }))
  await writeFile(join(authDir, "claude-c.json"), JSON.stringify({ type: "claude", access_token: "tok", refresh_token: "never", expired: future }))
  const seen = []
  const quota = await fetchClaude({
    authDir,
    fetchFn: async (url, options) => {
      seen.push(options.headers.Authorization)
      return new Response(JSON.stringify({ five_hour: { utilization: 50 }, seven_day: { utilization: 95 } }), { status: 200 })
    },
  })
  assert.deepEqual(seen, ["Bearer tok"])
  assert.deepEqual({ fiveHourLeft: quota.fiveHourLeft, weeklyLeft: quota.weeklyLeft }, { fiveHourLeft: 50, weeklyLeft: 5 })
})
