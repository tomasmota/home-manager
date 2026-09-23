import assert from "node:assert/strict"
import test from "node:test"

import { JevAutoApprovePlugin } from "../plugins/auto-approve-jev.js"

const {
  composeJevDecision,
  isAutoAllowable,
  isCatastrophic,
  jevState,
  normalizeRequest,
  parseFallbackDecision,
  parseFallbackModels,
  parseJevResponse,
} = JevAutoApprovePlugin.__test()

function result({ danger, dangerConfidence = 1, blast, blastConfidence = 1, purpose, category = "ambiguous_other", categoryConfidence = 1 }) {
  return {
    model: "jev-1.13.0",
    usage: { input_tokens: 900 },
    dangerousness: { score: danger, confidence: dangerConfidence, probabilities: {} },
    blastRadius: { score: blast, confidence: blastConfidence, probabilities: {} },
    purpose,
    category: { choice: category, confidence: categoryConfidence, probabilities: {} },
  }
}

test("normalizes v2 permission evaluations", () => {
  assert.deepEqual(normalizeRequest({ sessionID: "ses_1", action: "shell", resources: ["rm -rf ./build"] }), {
    sessionID: "ses_1",
    action: "shell",
    resources: ["rm -rf ./build"],
    title: undefined,
  })
  assert.equal(normalizeRequest({ sessionID: "ses_2", action: "shell", resources: ["git status"], message: "Run" }).title, "Run")
})

test("keeps deterministic catastrophic protection", () => {
  assert.equal(isCatastrophic("shell\nrm -rf /"), true)
  assert.equal(isCatastrophic("shell\nmkfs.ext4 /dev/sda1"), true)
  assert.equal(isCatastrophic("shell\nrm -rf ./build"), false)
})

test("sends structured, bounded state without metadata", () => {
  const state = jevState({ action: "shell", title: "Run", resources: ["x".repeat(2500)] }, "/work/app")
  assert.equal(state.project_directory, "/work/app")
  assert.equal(state.permission.resources[0].length, 2000)
  assert.deepEqual(Object.keys(state.permission), ["action", "title", "resources"])
})

test("parses the documented Jev response shape", () => {
  const parsed = parseJevResponse({
    model: "jev-1.13.0",
    answers: {
      dangerousness: { type: "score", score: 3, confidence: 1, probabilities: { 3: 1 } },
      blast_radius: { type: "score", score: 3, confidence: 1, probabilities: { 3: 1 } },
      plausible_dev_purpose: { type: "noul", noul: 0.05 },
      risk_category: { type: "choice", choice: "broad_data_destruction", confidence: 1, probabilities: { broad_data_destruction: 1 } },
    },
    usage: { input_tokens: 900, output_tokens: 50 },
  })
  assert.equal(parsed.model, "jev-1.13.0")
  assert.equal(parsed.purpose, 0.05)
  assert.equal(parsed.category.choice, "broad_data_destruction")
})

test("denies only when every policy leg is strongly met", () => {
  assert.deepEqual(composeJevDecision(result({ danger: 3, blast: 3, purpose: 0.1, category: "credential_exfiltration" })), {
    decision: "deny",
    reasonCode: "jev_credential_exfiltration",
    reason: "This would expose credentials or secrets at scale; inspect only the specifically authorized non-secret data instead.",
  })
  assert.equal(composeJevDecision(result({ danger: 3, blast: 3, purpose: 0.9 })).decision, "allow")
  assert.equal(composeJevDecision(result({ danger: 1.2, blast: 1, purpose: 0.2 })).decision, "allow")
})

test("routes borderline high-risk results to the LLM fallback", () => {
  assert.equal(composeJevDecision(result({ danger: 2.6, blast: 2.6, purpose: 0.5 })).decision, "fallback")
  assert.equal(composeJevDecision(result({ danger: 2.7, dangerConfidence: 0.3, blast: 2.7, blastConfidence: 0.3, purpose: 0.2 })).decision, "fallback")
})

test("validates LLM fallback decisions", () => {
  assert.deepEqual(parseFallbackDecision({ decision: "allow", reasonCode: "scoped_work", reason: "Scoped and recoverable." }), {
    decision: "allow", reasonCode: "scoped_work", reason: "Scoped and recoverable.",
  })
  assert.equal(parseFallbackDecision({ decision: "maybe", reasonCode: "bad", reason: "No." }), null)
  assert.deepEqual(parseFallbackModels("openai/model,zai/other"), [
    { providerID: "openai", modelID: "model" },
    { providerID: "zai", modelID: "other" },
  ])
  assert.throws(() => parseFallbackModels("invalid"), /Invalid fallback model/)
})

function harness(generate = { text: async () => { throw new Error("fallback should not run") } }) {
  let evaluate
  const context = {
    location: { directory: "/work/app" },
    generate,
    permission: { hook: async (name, callback) => {
      assert.equal(name, "evaluate")
      evaluate = callback
    } },
  }
  return JevAutoApprovePlugin.setup(context).then(() => evaluate)
}

test("v2 evaluate hook allows a safe Jev result", async () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.TYPESAFE_API_KEY
  process.env.TYPESAFE_API_KEY = "test-key"
  process.env.OPENCODE_JEV_DEBUG = "0"
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        dangerousness: { type: "score", score: 1.2, confidence: 0.8, probabilities: {} },
        blast_radius: { type: "score", score: 1, confidence: 1, probabilities: {} },
        plausible_dev_purpose: { type: "noul", noul: 0.95 },
        risk_category: { type: "choice", choice: "routine_or_scoped", confidence: 1, probabilities: {} },
      },
      usage: { input_tokens: 850 },
    }), { status: 200 })
    const evaluate = await harness()
    const event = { sessionID: "ses_1", action: "shell", resources: ["rm -rf ./build"], effect: "ask" }
    await evaluate(event)
    assert.equal(event.effect, "allow")
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = originalKey
  }
})

test("v2 evaluate hook denies catastrophic actions without a reviewer", async () => {
  const originalFetch = globalThis.fetch
  process.env.OPENCODE_JEV_DEBUG = "0"
  try {
    globalThis.fetch = async () => { throw new Error("must not call Jev") }
    const evaluate = await harness()
    const event = { sessionID: "ses_2", action: "shell", resources: ["rm -rf /"], effect: "ask" }
    await evaluate(event)
    assert.equal(event.effect, "deny")
    assert.match(event.message, /blocked this action/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("v2 stateless fallback returns a validated decision without creating a session", async () => {
  const originalKey = process.env.TYPESAFE_API_KEY
  const originalModels = process.env.OPENCODE_JEV_FALLBACK_MODELS
  delete process.env.TYPESAFE_API_KEY
  process.env.OPENCODE_JEV_FALLBACK_MODELS = "openai/test-model"
  process.env.OPENCODE_JEV_DEBUG = "0"
  try {
    const calls = []
    const evaluate = await harness({ text: async (args) => {
      calls.push(args)
      return { text: '{"decision":"allow","reasonCode":"scoped_work","reason":"Scoped and recoverable."}' }
    } })
    const event = { sessionID: "ses_3", action: "shell", resources: ["custom-command"], effect: "ask" }
    await evaluate(event)
    assert.equal(event.effect, "allow")
    assert.deepEqual(calls[0].model, { providerID: "openai", id: "test-model" })
  } finally {
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = originalKey
    if (originalModels === undefined) delete process.env.OPENCODE_JEV_FALLBACK_MODELS
    else process.env.OPENCODE_JEV_FALLBACK_MODELS = originalModels
  }
})

test("read-only actions auto-allow without reviewer", () => {
  for (const action of ["skill", "read", "glob", "grep", "webfetch", "websearch", "question"]) {
    assert.equal(isAutoAllowable({ action, resources: ["takeover"] }), true, action)
  }
  assert.equal(isAutoAllowable({ action: "shell", resources: ["takeover"] }), false)
  assert.equal(isAutoAllowable({ action: "edit", resources: ["takeover"] }), false)
})

test("v2 evaluate hook allows skill reads without calling reviewers", async () => {
  const originalFetch = globalThis.fetch
  process.env.OPENCODE_JEV_DEBUG = "0"
  try {
    globalThis.fetch = async () => { throw new Error("must not call Jev for skill reads") }
    const evaluate = await harness({ text: async () => { throw new Error("must not call fallback for skill reads") } })
    const event = { sessionID: "ses_skill", action: "skill", resources: ["takeover"], effect: "ask" }
    await evaluate(event)
    assert.equal(event.effect, "allow")
  } finally {
    globalThis.fetch = originalFetch
  }
})
