import assert from "node:assert/strict"
import test from "node:test"

import { JevAutoApprovePlugin } from "../plugins/auto-approve-jev.js"
import { isIgnoredSession } from "../plugins/lib/session-registry.js"

const {
  composeJevDecision,
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

test("normalizes current and legacy permission events", () => {
  assert.deepEqual(normalizeRequest({ id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["rm -rf ./build"] }), {
    id: "per_1",
    sessionID: "ses_1",
    action: "bash",
    resources: ["rm -rf ./build"],
    title: undefined,
  })
  assert.equal(normalizeRequest({ id: "per_2", sessionID: "ses_2", type: "bash", pattern: "git status" }).resources[0], "git status")
})

test("keeps deterministic catastrophic protection", () => {
  assert.equal(isCatastrophic("bash\nrm -rf /"), true)
  assert.equal(isCatastrophic("bash\nmkfs.ext4 /dev/sda1"), true)
  assert.equal(isCatastrophic("bash\nrm -rf ./build"), false)
})

test("sends structured, bounded state without metadata", () => {
  const state = jevState({ action: "bash", title: "Run", resources: ["x".repeat(2500)] }, "/work/app")
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
    decision: "allow",
    reasonCode: "scoped_work",
    reason: "Scoped and recoverable.",
  })
  assert.equal(parseFallbackDecision({ decision: "maybe", reasonCode: "bad", reason: "No." }), null)
  assert.deepEqual(parseFallbackModels("openai/model,zai/other"), [
    { providerID: "openai", modelID: "model" },
    { providerID: "zai", modelID: "other" },
  ])
  assert.throws(() => parseFallbackModels("invalid"), /Invalid fallback model/)
})

test("handles a permission event through Jev and the legacy reply API", async () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.TYPESAFE_API_KEY
  const originalDebug = process.env.OPENCODE_JEV_DEBUG
  const replies = []
  try {
    process.env.TYPESAFE_API_KEY = "test-key"
    process.env.OPENCODE_JEV_DEBUG = "0"
    globalThis.fetch = async () => new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        dangerousness: { type: "score", score: 1.2, confidence: 0.8, probabilities: { 1: 0.8, 2: 0.2 } },
        blast_radius: { type: "score", score: 1, confidence: 1, probabilities: { 1: 1 } },
        plausible_dev_purpose: { type: "noul", noul: 0.95 },
        risk_category: { type: "choice", choice: "routine_or_scoped", confidence: 1, probabilities: { routine_or_scoped: 1 } },
      },
      usage: { input_tokens: 850, output_tokens: 40 },
    }), { status: 200, headers: { "Content-Type": "application/json" } })
    const client = {
      postSessionIdPermissionsPermissionId: async (args) => {
        replies.push(args)
        return { response: { status: 200 } }
      },
    }
    const hooks = await JevAutoApprovePlugin({ client, directory: "/work/app" })
    await hooks.event({ event: {
      type: "permission.asked",
      properties: { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["rm -rf ./build"] },
    } })
    assert.equal(replies.length, 1)
    assert.equal(replies[0].body.response, "once")
    assert.deepEqual(replies[0].query, { directory: "/work/app" })
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = originalKey
    if (originalDebug === undefined) delete process.env.OPENCODE_JEV_DEBUG
    else process.env.OPENCODE_JEV_DEBUG = originalDebug
  }
})

test("rejects catastrophic actions and resumes with the requesting route", async () => {
  const originalFetch = globalThis.fetch
  const originalDebug = process.env.OPENCODE_JEV_DEBUG
  const replies = []
  const resumes = []
  try {
    process.env.OPENCODE_JEV_DEBUG = "0"
    globalThis.fetch = async () => { throw new Error("catastrophic policy must not call Jev") }
    const client = {
      postSessionIdPermissionsPermissionId: async (args) => {
        replies.push(args)
        return { response: { status: 200 } }
      },
      session: {
        messages: async () => ({ data: [{ info: { role: "user", agent: "build", model: { providerID: "openai", modelID: "gpt-test", variant: "fast" } } }] }),
        status: async () => ({ data: { ses_2: { type: "idle" } } }),
        promptAsync: async (args) => {
          resumes.push(args)
          return { response: { status: 204 } }
        },
      },
    }
    const hooks = await JevAutoApprovePlugin({ client, directory: "/work/app" })
    await hooks.event({ event: {
      type: "permission.v2.asked",
      data: { id: "per_2", sessionID: "ses_2", permission: "bash", patterns: ["rm -rf /"] },
    } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(replies[0].body.response, "reject")
    assert.equal(resumes.length, 1)
    assert.equal(resumes[0].body.agent, "build")
    assert.deepEqual(resumes[0].body.model, { providerID: "openai", modelID: "gpt-test" })
    assert.equal(resumes[0].body.variant, "fast")
  } finally {
    globalThis.fetch = originalFetch
    if (originalDebug === undefined) delete process.env.OPENCODE_JEV_DEBUG
    else process.env.OPENCODE_JEV_DEBUG = originalDebug
  }
})

test("retries an unrouted legacy permission reply after a routed 404", async () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.TYPESAFE_API_KEY
  const originalDebug = process.env.OPENCODE_JEV_DEBUG
  const replies = []
  try {
    process.env.TYPESAFE_API_KEY = "test-key"
    process.env.OPENCODE_JEV_DEBUG = "0"
    globalThis.fetch = async () => new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        dangerousness: { type: "score", score: 0, confidence: 1, probabilities: { 0: 1 } },
        blast_radius: { type: "score", score: 0, confidence: 1, probabilities: { 0: 1 } },
        plausible_dev_purpose: { type: "noul", noul: 1 },
        risk_category: { type: "choice", choice: "routine_or_scoped", confidence: 1, probabilities: { routine_or_scoped: 1 } },
      },
      usage: { input_tokens: 800, output_tokens: 40 },
    }), { status: 200, headers: { "Content-Type": "application/json" } })
    const client = {
      postSessionIdPermissionsPermissionId: async (args) => {
        replies.push(args)
        return replies.length === 1 ? { response: { status: 404 } } : { response: { status: 200 } }
      },
    }
    const hooks = await JevAutoApprovePlugin({ client, directory: "/work/app" })
    await hooks.event({ event: {
      type: "permission.asked",
      properties: { id: "per_3", sessionID: "ses_3", permission: "bash", patterns: ["custom-safe-command"] },
    } })
    assert.equal(replies.length, 2)
    assert.deepEqual(replies[0].query, { directory: "/work/app" })
    assert.equal(replies[1].query, undefined)
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = originalKey
    if (originalDebug === undefined) delete process.env.OPENCODE_JEV_DEBUG
    else process.env.OPENCODE_JEV_DEBUG = originalDebug
  }
})

test("registers LLM fallback sessions for status filtering", async () => {
  const originalKey = process.env.TYPESAFE_API_KEY
  const originalDebug = process.env.OPENCODE_JEV_DEBUG
  const originalModels = process.env.OPENCODE_JEV_FALLBACK_MODELS
  try {
    delete process.env.TYPESAFE_API_KEY
    process.env.OPENCODE_JEV_DEBUG = "0"
    process.env.OPENCODE_JEV_FALLBACK_MODELS = "openai/test-model"
    const client = {
      permission: { reply: async () => ({ response: { status: 200 } }) },
      session: {
        create: async () => ({ data: { id: "ses_fallback_test" } }),
        prompt: async () => ({ data: {
          info: { structured: { decision: "allow", reasonCode: "scoped_work", reason: "Scoped and recoverable." } },
        } }),
        delete: async () => ({ response: { status: 204 } }),
      },
    }
    const hooks = await JevAutoApprovePlugin({ client, directory: "/work/app" })
    await hooks.event({ event: {
      type: "permission.asked",
      properties: { id: "per_fallback", sessionID: "ses_primary", permission: "bash", patterns: ["custom-command"] },
    } })
    assert.equal(isIgnoredSession("ses_fallback_test"), true)
  } finally {
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = originalKey
    if (originalDebug === undefined) delete process.env.OPENCODE_JEV_DEBUG
    else process.env.OPENCODE_JEV_DEBUG = originalDebug
    if (originalModels === undefined) delete process.env.OPENCODE_JEV_FALLBACK_MODELS
    else process.env.OPENCODE_JEV_FALLBACK_MODELS = originalModels
  }
})
