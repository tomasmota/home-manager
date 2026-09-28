import assert from "node:assert/strict"
import test from "node:test"

import { StuckCommandJevPlugin } from "../plugins/stuck-command/stuck-command-jev.js"

const { QUESTIONS, watchdogConfig, shellCall, jevState, parseJevResponse, stuckMessage, createWatchdog } =
  StuckCommandJevPlugin.__test()

const config = { firstCheckMs: 60_000, intervalMs: 60_000, threshold: 0.8, jevTimeoutMs: 5000 }

function jevAnswer(scores = {}) {
  const answers = {}
  for (const id of Object.keys(QUESTIONS)) answers[id] = { type: "noul", noul: scores[id] ?? 0.1 }
  return { model: "jev-1.13.0", answers }
}

function harness(t, answers) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  const requests = []
  const calls = []
  const audits = []
  const watchdog = createWatchdog({
    config,
    jev: async (request) => {
      requests.push(request)
      const next = answers.shift()
      if (next instanceof Error) throw next
      return next
    },
    session: {
      interrupt: async (input) => void calls.push(["interrupt", input]),
      synthetic: async (input) => void calls.push(["synthetic", input]),
    },
    audit: async (record) => void audits.push(record),
  })
  t.after(() => watchdog.dispose())
  return { watchdog, requests, calls, audits }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

function shellEvent(id, command, extra = {}) {
  return { tool: "shell", sessionID: "ses_1", agent: "build", messageID: "msg_1", id, input: { command, timeout: 600000, ...extra } }
}

test("reads timing from options before env", () => {
  assert.deepEqual(watchdogConfig({}, {}), { firstCheckMs: 60_000, intervalMs: 60_000, threshold: 0.8, jevTimeoutMs: 5000 })
  const env = { OPENCODE_STUCK_FIRST_CHECK_SECONDS: "90", OPENCODE_STUCK_CHECK_INTERVAL_SECONDS: "30", OPENCODE_STUCK_THRESHOLD: "0.7" }
  assert.deepEqual(watchdogConfig({}, env), { firstCheckMs: 90_000, intervalMs: 30_000, threshold: 0.7, jevTimeoutMs: 5000 })
  assert.equal(watchdogConfig({ firstCheckSeconds: 5, threshold: 0.9 }, env).firstCheckMs, 5000)
  assert.equal(watchdogConfig({ threshold: 2 }, env).threshold, 0.7)
})

test("watches only foreground shell commands", () => {
  assert.deepEqual(shellCall(shellEvent("c", "npm test")), { command: "npm test", timeoutMs: 600000 })
  assert.equal(shellCall({ tool: "read", input: { command: "x" } }), null)
  assert.equal(shellCall(shellEvent("c", "npm run dev", { background: true })), null)
  assert.equal(shellCall(shellEvent("c", "  ")), null)
})

test("state reports elapsed time, check number, and recent commands", () => {
  const entry = { call: { command: "npm test", description: "Run tests" }, startedAt: 0, checks: 3 }
  const state = jevState(entry, [{ command: "npm ci", duration_seconds: 40, outcome: "exit 0" }], 180_000)
  assert.equal(state.running.elapsed_seconds, 180)
  assert.equal(state.running.check_number, 3)
  assert.equal(state.running.earlier_checks_judged_still_working, 2)
  assert.equal(state.recent_commands[0].command, "npm ci")
  assert.equal(jevState({ call: { command: "x".repeat(5000) }, startedAt: 0, checks: 1 }, [], 0).running.command.length, 2000)
})

test("parses the strongest hang judgment and rejects incomplete answers", () => {
  const parsed = parseJevResponse(jevAnswer({ runs_until_stopped: 0.93, overdue: 0.3 }))
  assert.equal(parsed.cause, "runs_until_stopped")
  assert.equal(parsed.hung, 0.93)
  const missing = jevAnswer()
  delete missing.answers.blocked
  assert.equal(parseJevResponse(missing), null)
  assert.equal(parseJevResponse({ answers: jevAnswer().answers }), null)
})

test("message names the command, runtime, and cause", () => {
  const text = stuckMessage({ call: { command: "tail -f `app.log`" }, startedAt: 0 }, { cause: "runs_until_stopped" }, 61_000)
  assert.match(text, /tail -f 'app\.log'/)
  assert.match(text, /running for 61 seconds and it may be a process that runs until stopped/)
  assert.match(text, /If that was expected, ignore this message and continue/)
})

test("checks after the first delay, then every interval with an increasing check number", async (t) => {
  const { watchdog, requests, calls } = harness(t, [jevAnswer(), jevAnswer({ overdue: 0.5 })])
  watchdog.before(shellEvent("call_1", "cargo build --release"))
  t.mock.timers.tick(59_999)
  await flush()
  assert.equal(requests.length, 0)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].state.running.check_number, 1)
  assert.equal(requests[0].state.running.elapsed_seconds, 60)
  t.mock.timers.tick(60_000)
  await flush()
  assert.equal(requests.length, 2)
  assert.equal(requests[1].state.running.check_number, 2)
  assert.equal(requests[1].state.running.elapsed_seconds, 120)
  assert.equal(calls.length, 0)
})

test("interrupts and explains when a judgment reaches the threshold", async (t) => {
  const { watchdog, calls, audits } = harness(t, [jevAnswer({ runs_until_stopped: 0.95 })])
  watchdog.before(shellEvent("call_1", "npm run dev"))
  t.mock.timers.tick(60_000)
  await flush()
  assert.deepEqual(calls[0], ["interrupt", { sessionID: "ses_1", resume: false }])
  assert.equal(calls[1][0], "synthetic")
  assert.equal(calls[1][1].sessionID, "ses_1")
  assert.match(calls[1][1].text, /`npm run dev` is hanging; it had been running for 60 seconds/)
  assert.equal(audits.at(-1).outcome, "interrupted")
  assert.equal(watchdog.running.size, 0)

  // The aborted result is ignored; history records the interrupt instead.
  watchdog.after({ ...shellEvent("call_1", "npm run dev"), status: "error", error: { message: "Tool execution interrupted" } })
  assert.deepEqual(watchdog.history.get("ses_1"), [
    { command: "npm run dev", duration_seconds: 60, outcome: "interrupted by stuck-command watchdog" },
  ])
})

test("finished commands stop checks and join the session history", async (t) => {
  const { watchdog, requests } = harness(t, [])
  watchdog.before(shellEvent("call_1", "npm ci"))
  t.mock.timers.tick(40_000)
  watchdog.after({ ...shellEvent("call_1", "npm ci"), status: "completed", result: { metadata: { exit: 0 } } })
  t.mock.timers.tick(120_000)
  await flush()
  assert.equal(requests.length, 0)
  assert.deepEqual(watchdog.history.get("ses_1"), [{ command: "npm ci", duration_seconds: 40, outcome: "exit 0" }])

  for (let i = 0; i < 7; i++) {
    watchdog.after({ ...shellEvent(`call_${i + 2}`, `echo ${i}`), status: "error", error: { message: "x" } })
  }
  assert.equal(watchdog.history.get("ses_1").length, 5)
  assert.equal(watchdog.history.get("ses_1")[0].command, "echo 2")
})

test("does not interrupt a command that finished while Jev was answering", async (t) => {
  let release
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  const calls = []
  const watchdog = createWatchdog({
    config,
    jev: () => new Promise((resolve) => (release = resolve)),
    session: { interrupt: async () => calls.push("interrupt"), synthetic: async () => calls.push("synthetic") },
  })
  t.after(() => watchdog.dispose())
  watchdog.before(shellEvent("call_1", "make"))
  t.mock.timers.tick(60_000)
  await flush()
  watchdog.after({ ...shellEvent("call_1", "make"), status: "completed", result: {} })
  release(jevAnswer({ overdue: 0.99 }))
  await flush()
  assert.deepEqual(calls, [])
})

test("keeps watching when Jev is unavailable", async (t) => {
  const { watchdog, requests, calls, audits } = harness(t, [new Error("Jev HTTP 503"), jevAnswer({ waits_for_input: 0.9 })])
  watchdog.before(shellEvent("call_1", "git commit"))
  t.mock.timers.tick(60_000)
  await flush()
  assert.equal(audits[0].outcome, "jev_unavailable")
  assert.equal(calls.length, 0)
  t.mock.timers.tick(60_000)
  await flush()
  assert.equal(requests.length, 2)
  assert.equal(requests[1].state.running.check_number, 2)
  assert.equal(calls[0][0], "interrupt")
})

test("interrupting a session stops every watched command in it", async (t) => {
  const { watchdog, requests, calls } = harness(t, [jevAnswer({ blocked: 0.9 })])
  watchdog.before(shellEvent("call_1", "ssh host uptime"))
  t.mock.timers.tick(30_000)
  watchdog.before(shellEvent("call_2", "sleep 100"))
  watchdog.before({ ...shellEvent("call_3", "make"), sessionID: "ses_2" })
  t.mock.timers.tick(30_000)
  await flush()
  assert.equal(calls.filter(([name]) => name === "interrupt").length, 1)
  assert.deepEqual([...watchdog.running.keys()], ["call_3"])
  assert.equal(requests.length, 1)
})
