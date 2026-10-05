import { test, before, beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Nix installs the adapter beside the rendered shared reviewer; mirror that.
const shared = new URL("../../opencode/lib/permission-review/", import.meta.url)
const bundle = mkdtempSync(join(tmpdir(), "omp-jev-"))
const auditDir = mkdtempSync(join(tmpdir(), "omp-jev-audit-"))
for (const file of ["permission-review.js", "jev-client.js", "decision-audit.js"]) {
  copyFileSync(new URL(file, shared), join(bundle, file))
}
copyFileSync(new URL("../auto-approve-jev.ts", import.meta.url), join(bundle, "auto-approve-jev.ts"))
writeFileSync(join(bundle, "package.json"), JSON.stringify({ type: "module" }))

const ENV_KEYS = [
  "TYPESAFE_API_KEY", "OPENCODE_JEV_MODEL", "OPENCODE_JEV_TIMEOUT_MS", "OPENCODE_JEV_DANGER_MIN",
  "OPENCODE_JEV_BLAST_MIN", "OPENCODE_JEV_PURPOSE_MAX", "OPENCODE_JEV_CONFIDENCE_MIN",
  "OPENCODE_JEV_FALLBACK_MODELS", "OPENCODE_JEV_FALLBACK_TIMEOUT_MS", "OPENCODE_JEV_ON_EXHAUSTION",
  "OPENCODE_JEV_DEBUG", "OPENCODE_REVIEW_DIR", "OPENCODE_SECRETS_FILE",
]
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
const auditBase = join(auditDir, "decisions.jsonl")
const SECRET = "sk-test-secret-should-never-surface"

let adapter
before(async () => {
  adapter = await import(join(bundle, "auto-approve-jev.ts"))
})
beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.OPENCODE_SECRETS_FILE = join(bundle, "missing-secrets.env")
  process.env.OPENCODE_JEV_DEBUG = auditBase
  for (const file of readdirSync(auditDir)) rmSync(join(auditDir, file))
})
after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(bundle, { recursive: true, force: true })
  rmSync(auditDir, { recursive: true, force: true })
})

const audits = () => readdirSync(auditDir).flatMap(file =>
  readFileSync(join(auditDir, file), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)))

const jevAnswer = (risky) => ({
  model: "jev-test",
  usage: {},
  answers: risky
    ? {
      dangerousness: { type: "score", score: 3, confidence: 0.9 },
      blast_radius: { type: "score", score: 3, confidence: 0.9 },
      plausible_dev_purpose: { type: "noul", noul: 0.05 },
      risk_category: { type: "choice", choice: "broad_data_destruction", confidence: 0.9 },
    }
    : {
      dangerousness: { type: "score", score: 0.2, confidence: 0.9 },
      blast_radius: { type: "score", score: 0.2, confidence: 0.9 },
      plausible_dev_purpose: { type: "noul", noul: 0.95 },
      risk_category: { type: "choice", choice: "routine_or_scoped", confidence: 0.9 },
    },
})

const CATALOG = [
  { provider: "openai", id: "gpt-5.6-luna" },
  { provider: "openai-codex", id: "gpt-5.6-luna" },
  { provider: "inco", id: "glm-5.3-flash:fast" },
]

function harness({ hasUI = false, confirm, typesafe = "ts-broker-key", keys = {}, jev, complete } = {}) {
  const calls = { jev: [], complete: [], confirm: [] }
  const modelRegistry = {
    find: (provider, id) => CATALOG.find(m => m.provider === provider && m.id === id),
    getApiKey: async model => keys[model.provider],
    getApiKeyForProvider: async provider => {
      if (typeof typesafe === "function") return typesafe(provider)
      return provider === "typesafe" ? typesafe : undefined
    },
    resolver: model => ({ resolverFor: `${model.provider}/${model.id}` }),
  }
  const ctx = {
    cwd: "/repo",
    hasUI,
    ui: { confirm: async (title, message) => { calls.confirm.push({ title, message }); return confirm(title, message) } },
    modelRegistry,
    sessionManager: { getSessionId: () => "session-1" },
  }
  const deps = {
    requestJev: async args => {
      calls.jev.push(args)
      if (!jev) throw new Error("Jev must not be called")
      return jev(args)
    },
    completeSimple: async (model, context, options) => {
      calls.complete.push({ model, context, options })
      if (!complete) throw new Error("fallback must not be called")
      return complete(model, context, options)
    },
  }
  const review = (toolName, input) => adapter.reviewToolCall({ toolName, input }, ctx, deps)
  return { calls, review }
}

const reply = text => ({ stopReason: "stop", content: [{ type: "text", text }] })

test("native read-only and scheduling tools skip review; write/xd and eval do not", async () => {
  const { calls, review } = harness()
  for (const tool of ["read", "grep", "glob", "find", "web_search", "ask", "todo", "wait", "task"]) {
    assert.equal(await review(tool, { path: "/" }), undefined)
  }
  assert.equal(calls.jev.length, 0)
  assert.equal(adapter.SKIPPED_TOOLS.write, undefined)
  assert.equal(adapter.SKIPPED_TOOLS.eval, undefined)
  assert.equal(adapter.SKIPPED_TOOLS.constructor === true, false)

  const reviewed = harness({ jev: () => jevAnswer(false) })
  assert.equal(await reviewed.review("write", { path: "xd://read", content: "{\"path\":\"README.md\"}" }), undefined)
  assert.equal(await reviewed.review("eval", { language: "py", code: "1 + 1" }), undefined)
  assert.deepEqual(reviewed.calls.jev.map(args => args.state.permission.action), ["write", "eval"])
})

test("routine bash is allowed through Jev with the broker TypeSafe key", async () => {
  const { calls, review } = harness({ jev: () => jevAnswer(false) })
  assert.equal(await review("bash", { command: "npm test && git status" }), undefined)
  assert.equal(calls.jev.length, 1)
  assert.equal(calls.jev[0].apiKey, "ts-broker-key")
  assert.equal(calls.jev[0].state.project_directory, "/repo")
  assert.deepEqual(calls.jev[0].state.permission.resources, ["npm test && git status"])
  const [record] = audits()
  assert.equal(record.decision, "allow")
  assert.equal(record.source, "jev")
  assert.equal(record.sessionID, "session-1")
})

test("Jev deny blocks with the shared reason", async () => {
  const { review } = harness({ jev: () => jevAnswer(true) })
  const result = await review("mcp__confluence_updateconfluencepage", { pageId: "1", body: "wipe" })
  assert.equal(result.block, true)
  assert.match(result.reason, /^Jev auto-approve blocked this action: This would cause broad, irreversible data loss/)
})

test("catastrophic guard blocks bash, eval and nested xd dispatch without inference", async () => {
  const { calls, review } = harness()
  for (const [tool, input] of [
    ["bash", { command: "rm -rf ~" }],
    ["eval", { language: "py", code: "import subprocess\nsubprocess.run('mkfs.ext4 /dev/sda', shell=True)" }],
    ["write", { path: "xd://mcp__shell_exec", content: JSON.stringify({ script: "rm -rf / " }) }],
  ]) {
    const result = await review(tool, input)
    assert.equal(result?.block, true, tool)
    assert.match(result.reason, /broad, irreversible data loss/)
  }
  assert.equal(calls.jev.length, 0)
  assert.deepEqual(audits().map(r => r.source), ["policy", "policy", "policy"])
})

test("manual review blocks headless, honours the user's choice and propagates cancellation", async () => {
  process.env.OPENCODE_JEV_ON_EXHAUSTION = "manual"
  const fail = () => { throw new Error("down") }

  const headless = harness({ jev: fail, complete: fail, keys: { "openai-codex": "k", inco: "k" } })
  const blocked = await headless.review("bash", { command: "make deploy" })
  assert.equal(blocked.block, true)
  assert.match(blocked.reason, /no interactive UI/)

  const approved = harness({ hasUI: true, confirm: () => true, jev: fail })
  assert.equal(await approved.review("bash", { command: "make deploy" }), undefined)
  assert.match(approved.calls.confirm[0].message, /^Tool: bash\nmake deploy$/)

  const rejected = harness({ hasUI: true, confirm: () => false, jev: fail })
  assert.match((await rejected.review("bash", { command: "make deploy" })).reason, /rejected by user/)

  const cancelled = harness({ hasUI: true, confirm: () => { throw new DOMException("aborted", "AbortError") }, jev: fail })
  await assert.rejects(cancelled.review("bash", { command: "make deploy" }), { name: "AbortError" })
})

test("exhausted reviewers keep the shared default allow, or deny when configured", async () => {
  const fail = () => { throw new Error("down") }
  const { calls, review } = harness({ jev: fail })
  assert.equal(await review("bash", { command: "make deploy" }), undefined)
  assert.equal(calls.complete.length, 0)
  assert.equal(audits()[0].source, "exhaustion")
  assert.equal(audits()[0].reasonCode, "reviewers_unavailable_fail_open")

  process.env.OPENCODE_JEV_ON_EXHAUSTION = "deny"
  assert.equal((await harness({ jev: fail }).review("bash", { command: "make deploy" })).block, true)
})

test("fallback maps OpenCode openai to openai-codex and keeps exact model ids", async () => {
  const fail = () => { throw new Error("down") }
  const translated = harness({
    jev: fail,
    keys: { "openai-codex": "codex-token" },
    complete: () => reply("{\"decision\":\"deny\",\"reasonCode\":\"wipe\",\"reason\":\"Target the build directory instead.\"}"),
  })
  const denied = await translated.review("bash", { command: "make clean-all" })
  assert.equal(denied.reason, "Jev auto-approve blocked this action: Target the build directory instead.")
  assert.deepEqual(translated.calls.complete[0].model, { provider: "openai-codex", id: "gpt-5.6-luna" })
  assert.deepEqual(translated.calls.complete[0].options, { apiKey: { resolverFor: "openai-codex/gpt-5.6-luna" }, sessionId: "session-1" })
  assert.match(translated.calls.complete[0].context.messages[0].content, /make clean-all/)

  const direct = harness({
    jev: fail,
    keys: { openai: "api-key", inco: "N/A" },
    complete: model => model.provider === "openai"
      ? { stopReason: "error", errorMessage: SECRET, content: [] }
      : reply("{\"decision\":\"allow\",\"reasonCode\":\"routine\",\"reason\":\"Routine.\"}"),
  })
  assert.equal(await direct.review("bash", { command: "make clean-all" }), undefined)
  assert.deepEqual(direct.calls.complete.map(c => `${c.model.provider}/${c.model.id}`), ["openai/gpt-5.6-luna", "inco/glm-5.3-flash:fast"])
  assert.equal(audits().at(-1).model, "inco/glm-5.3-flash:fast")
  assert.equal(audits().at(-1).source, "llm-fallback")

  await assert.rejects(
    adapter.resolveFallbackModel({ find: () => undefined, getApiKey: async () => undefined }, "openai", "gpt-nope", "s"),
    { message: "fallback model is not in the catalog" },
  )
})

test("credential seam failures never surface secrets and keep the shared fallback chain", async () => {
  const output = []
  const originals = Object.fromEntries(["log", "warn", "error", "info", "debug"].map(level => [level, console[level]]))
  for (const level of Object.keys(originals)) console[level] = (...args) => output.push(args.join(" "))
  try {
    const { calls, review } = harness({
      typesafe: () => { throw new Error(`broker unavailable ${SECRET}`) },
      keys: { "openai-codex": SECRET, inco: SECRET },
      jev: args => { throw new Error(`Jev HTTP 401 ${"apiKey" in args}`) },
      complete: () => { throw new Error(`upstream rejected ${SECRET}`) },
    })
    assert.equal(await review("bash", { command: "make deploy" }), undefined)
    assert.equal("apiKey" in calls.jev[0], false)
    assert.equal(calls.complete.length, 2)
    const record = audits()[0]
    assert.equal(record.source, "exhaustion")
    assert.equal(JSON.stringify(record).includes(SECRET), false)

    process.env.OPENCODE_JEV_ON_EXHAUSTION = "deny"
    const denied = await harness({
      typesafe: "N/A",
      jev: args => { throw new Error(`no key ${"apiKey" in args}`) },
      keys: { "openai-codex": SECRET },
      complete: () => ({ stopReason: "error", errorMessage: SECRET, content: [] }),
    }).review("bash", { command: "make deploy" })
    assert.equal(denied.block, true)
    assert.equal(denied.reason.includes(SECRET), false)
  } finally {
    Object.assign(console, originals)
  }
  assert.equal(output.some(line => line.includes(SECRET)), false)
})
