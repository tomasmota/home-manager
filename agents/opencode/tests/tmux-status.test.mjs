import assert from "node:assert/strict"
import test from "node:test"

import { TmuxStatusPlugin } from "../plugins/tmux-status.js"

const {
  aggregatePaneStates,
  buildCompletionState,
  composeAttentionDecision,
  createTmuxStatusPlugin,
  parseAttentionResponse,
} = TmuxStatusPlugin.__test()

async function harness(overrides = {}, input = {}) {
  const bells = []
  const states = []
  const hooks = await createTmuxStatusPlugin(input, {
    env: {},
    stdoutWrite: (value) => bells.push(value),
    onState: (state) => states.push(state),
    onExit: () => {},
    offExit: () => {},
    ...overrides,
  })
  return { bells, hooks, states }
}

function attentionResponse({
  needsAttention = 0.95,
  completedCleanly = 0.05,
  outcome = "awaiting_user_input",
  confidence = 0.9,
} = {}) {
  return {
    model: "jev-test",
    answers: {
      needs_attention: { type: "noul", noul: needsAttention },
      completed_cleanly: { type: "noul", noul: completedCleanly },
      outcome: { type: "choice", choice: outcome, confidence, probabilities: { [outcome]: 1 } },
    },
    usage: { input_tokens: 500 },
  }
}

test("aggregates pane states by severity and matching metadata", () => {
  assert.deepEqual(aggregatePaneStates([
    { state: "working", startedAt: "20" },
    { state: "waiting", startedAt: "10" },
  ]), { state: "waiting", startedAt: 10, duration: null })
  assert.deepEqual(aggregatePaneStates([
    { state: "working", startedAt: "10" },
    { state: "done", duration: "00:05", updatedAt: "20" },
    { state: "done", duration: "00:09", updatedAt: "30" },
  ]), { state: "done", startedAt: null, duration: "00:09" })
  assert.deepEqual(aggregatePaneStates([
    { state: "waiting", startedAt: "10" },
    { state: "error" },
  ]), { state: "error", startedAt: null, duration: null })
})

test("permission requests and clean completions are silent", async () => {
  const { bells, hooks } = await harness()
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: "busy" } } })
  await hooks.event({ event: { type: "permission.asked", properties: { sessionID: "ses_1" } } })
  await hooks.event({ event: { type: "permission.replied", properties: { sessionID: "ses_1" } } })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: "idle" } } })
  assert.deepEqual(bells, [])
  await hooks.dispose()
})

test("explicit questions ring", async () => {
  const { bells, hooks } = await harness()
  await hooks.event({ event: { type: "question.asked", properties: { sessionID: "ses_1" } } })
  assert.deepEqual(bells, ["\x07"])
  await hooks.dispose()
})

test("non-abort errors ring while user aborts stay silent", async () => {
  const hardError = await harness()
  await hardError.hooks.event({ event: { type: "session.error", properties: { sessionID: "ses_1", error: { name: "ProviderError" } } } })
  assert.deepEqual(hardError.bells, ["\x07"])
  await hardError.hooks.dispose()

  const abort = await harness()
  await abort.hooks.event({ event: { type: "session.error", properties: { sessionID: "ses_1", error: { name: "MessageAbortedError" } } } })
  assert.deepEqual(abort.bells, [])
  await abort.hooks.dispose()
})

test("debounces duplicate idle events", async () => {
  const timers = []
  let classifications = 0
  const { hooks } = await harness({
    env: { OPENCODE_JEV_ATTENTION_DEBOUNCE_MS: "10" },
    setTimeout: (callback) => {
      timers.push(callback)
      return callback
    },
    clearTimeout: () => {},
    classifyCompletion: async () => {
      classifications++
      return { state: "done" }
    },
  })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: "busy" } } })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: "idle" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } })
  assert.equal(timers.length, 1)
  await timers[0]()
  assert.equal(classifications, 1)
  await hooks.dispose()
})

test("rejects a late completion result after new activity", async () => {
  const timers = []
  let resolveClassification
  const classification = new Promise((resolve) => { resolveClassification = resolve })
  const { bells, hooks, states } = await harness({
    env: { OPENCODE_JEV_ATTENTION_DEBOUNCE_MS: "10" },
    setTimeout: (callback) => {
      timers.push(callback)
      return callback
    },
    clearTimeout: () => {},
    classifyCompletion: () => classification,
  })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: "busy" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } })
  const pending = timers[0]()
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: "busy" } } })
  resolveClassification({ state: "waiting" })
  await pending
  assert.equal(states.at(-1), "working")
  assert.deepEqual(bells, [])
  await hooks.dispose()
})

test("suppresses bells for visible windows and during cooldown", async () => {
  let visible = true
  let now = 1000
  const { bells, hooks } = await harness({
    env: { OPENCODE_JEV_ATTENTION_COOLDOWN_MS: "2000" },
    now: () => now,
    windowIsVisible: () => visible,
  })
  await hooks.event({ event: { type: "question.asked", properties: { sessionID: "ses_1" } } })
  visible = false
  await hooks.event({ event: { type: "question.asked", properties: { sessionID: "ses_1" } } })
  now += 100
  await hooks["tool.execute.before"]({ tool: "question", sessionID: "ses_1" })
  now += 2000
  await hooks.event({ event: { type: "session.error", properties: { sessionID: "ses_1", error: { name: "ProviderError" } } } })
  assert.deepEqual(bells, ["\x07", "\x07"])
  await hooks.dispose()
})

test("suppresses bells when more than one primary session is active", async () => {
  const { bells, hooks } = await harness()
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: "busy" } } })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_2", status: "busy" } } })
  await hooks.event({ event: { type: "question.asked", properties: { sessionID: "ses_1" } } })
  assert.deepEqual(bells, [])
  await hooks.dispose()
})

test("records another session completing while the visible state is waiting", async () => {
  const { bells, hooks, states } = await harness({
    env: { OPENCODE_JEV_ATTENTION_MODE: "off", OPENCODE_JEV_ATTENTION_COOLDOWN_MS: "0" },
  })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: "busy" } } })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_2", status: "busy" } } })
  await hooks.event({ event: { type: "permission.asked", properties: { sessionID: "ses_2" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } })
  await hooks.event({ event: { type: "permission.replied", properties: { sessionID: "ses_2" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } })
  assert.equal(states.at(-1), "working")
  await hooks.event({ event: { type: "question.asked", properties: { sessionID: "ses_2" } } })
  assert.deepEqual(bells, ["\x07"])
  await hooks.dispose()
})

test("removes deleted sessions from notification ownership", async () => {
  const { bells, hooks } = await harness({ env: { OPENCODE_JEV_ATTENTION_COOLDOWN_MS: "0" } })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: "busy" } } })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_2", status: "busy" } } })
  await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "ses_1" } } } })
  await hooks.event({ event: { type: "question.asked", properties: { sessionID: "ses_2" } } })
  assert.deepEqual(bells, ["\x07"])
  await hooks.dispose()
})

test("ignores fallback review sessions", async () => {
  const { bells, hooks, states } = await harness({
    isIgnoredSession: (sessionID) => sessionID === "ses_fallback",
  })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_primary", status: "busy" } } })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_fallback", status: "busy" } } })
  await hooks.event({ event: { type: "session.error", properties: { sessionID: "ses_fallback", error: { name: "ProviderError" } } } })
  assert.equal(states.at(-1), "working")
  assert.deepEqual(bells, [])
  await hooks.dispose()
})

test("builds a bounded transcript without tool output", () => {
  const context = buildCompletionState([
    {
      info: { role: "user", time: { created: 1 } },
      parts: [{ type: "text", text: `Please fix this ${"u".repeat(3000)}` }],
    },
    {
      info: { role: "assistant", time: { created: 2 }, finish: "stop" },
      parts: [
        { type: "tool", output: "SECRET_TOOL_OUTPUT" },
        { type: "text", text: `I need your choice ${"a".repeat(4000)}` },
      ],
    },
  ])
  assert.equal(context.summary.userTruncated, true)
  assert.equal(context.summary.assistantTruncated, true)
  assert.equal(context.state.latest_user_request.length, 2400)
  assert.equal(context.state.final_assistant_message.length, 3200)
  assert.doesNotMatch(JSON.stringify(context.state), /SECRET_TOOL_OUTPUT/)
})

test("preserves response ordering when message timestamps are incomplete", () => {
  const context = buildCompletionState([
    { info: { role: "user", time: { created: 1000 } }, parts: [{ type: "text", text: "old request" }] },
    { info: { role: "assistant", time: { created: 1001 } }, parts: [{ type: "text", text: "old response" }] },
    { info: { role: "user" }, parts: [{ type: "text", text: "latest request" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "latest response" }] },
  ])
  assert.equal(context.state.latest_user_request, "latest request")
  assert.equal(context.state.final_assistant_message, "latest response")
})

test("composes only strong actionable attention results", () => {
  const actionable = parseAttentionResponse(attentionResponse({ outcome: "blocked_failure" }))
  assert.deepEqual(composeAttentionDecision(actionable, {}).state, "error")
  assert.equal(composeAttentionDecision({ ...actionable, needsAttention: 0.7 }, {}).state, "done")
  assert.equal(composeAttentionDecision({ ...actionable, completedCleanly: 0.4 }, {}).state, "done")
  assert.equal(composeAttentionDecision({
    ...actionable,
    outcome: { ...actionable.outcome, confidence: 0.4 },
  }, {}).state, "done")
})

test("dry-run logs an actionable result without changing state or ringing", async () => {
  const timers = []
  const diagnostics = []
  const requests = []
  const client = {
    session: {
      messages: async () => ({ data: [
        { info: { role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "Deploy it" }] },
        { info: { role: "assistant", time: { created: 2 } }, parts: [{ type: "text", text: "Which environment should I use?" }] },
      ] }),
    },
  }
  const { bells, hooks, states } = await harness({
    env: { OPENCODE_JEV_ATTENTION_MODE: "dry-run", TYPESAFE_API_KEY: "test-key" },
    setTimeout: (callback) => {
      timers.push(callback)
      return callback
    },
    clearTimeout: () => {},
    requestJev: async (request) => {
      requests.push(request)
      return attentionResponse()
    },
    appendDiagnostic: async (record) => diagnostics.push(record),
  }, { client, directory: "/work/app" })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: "busy" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } })
  await timers[0]()
  assert.equal(states.at(-1), "done")
  assert.deepEqual(bells, [])
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].state.latest_user_request, "Deploy it")
  assert.equal(diagnostics[0].predictedState, "waiting")
  assert.equal(diagnostics[0].appliedState, "done")
  assert.equal(JSON.stringify(diagnostics).includes("Deploy it"), false)
  await hooks.dispose()
})

test("on mode applies actionable classifications", async () => {
  const timers = []
  const client = {
    session: {
      messages: async () => ({ data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "Finish setup" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "I am blocked by missing credentials." }] },
      ] }),
    },
  }
  const { bells, hooks, states } = await harness({
    env: { OPENCODE_JEV_ATTENTION_MODE: "on", TYPESAFE_API_KEY: "test-key" },
    setTimeout: (callback) => {
      timers.push(callback)
      return callback
    },
    clearTimeout: () => {},
    requestJev: async () => attentionResponse({ outcome: "blocked_failure" }),
    appendDiagnostic: async () => {},
  }, { client })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: "busy" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } })
  await timers[0]()
  assert.equal(states.at(-1), "error")
  assert.deepEqual(bells, ["\x07"])
  await hooks.dispose()
})

test("Jev failures stay silent and leave completion done", async () => {
  const timers = []
  const diagnostics = []
  const client = {
    session: {
      messages: async () => ({ data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "Run checks" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Checks could not run." }] },
      ] }),
    },
  }
  const { bells, hooks, states } = await harness({
    env: { OPENCODE_JEV_ATTENTION_MODE: "on", TYPESAFE_API_KEY: "test-key" },
    setTimeout: (callback) => {
      timers.push(callback)
      return callback
    },
    clearTimeout: () => {},
    requestJev: async () => { throw new Error("API unavailable") },
    appendDiagnostic: async (record) => diagnostics.push(record),
  }, { client })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: "busy" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } })
  await timers[0]()
  assert.equal(states.at(-1), "done")
  assert.deepEqual(bells, [])
  assert.equal(diagnostics[0].event, "failure")
  await hooks.dispose()
})

test("off mode does not schedule classification", async () => {
  const timers = []
  const client = { session: { messages: async () => { throw new Error("must not fetch messages") } } }
  const { hooks } = await harness({
    env: { OPENCODE_JEV_ATTENTION_MODE: "off" },
    setTimeout: (callback) => {
      timers.push(callback)
      return callback
    },
    clearTimeout: () => {},
  }, { client })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: "busy" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } })
  assert.equal(timers.length, 0)
  await hooks.dispose()
})
