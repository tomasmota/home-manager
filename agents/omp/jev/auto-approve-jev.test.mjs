import assert from "node:assert/strict"
import test, { after } from "node:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import autoApproveJev from "./auto-approve-jev.ts"

// Hermetic environment: no real kubeconfig, cloud profiles or reviewer config.
const root = mkdtempSync(join(tmpdir(), "auto-approve-jev-"))
const home = join(root, "home")
mkdirSync(home)
for (const name of [
  "KUBECONFIG", "HELM_KUBECONTEXT", "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "CLOUDSDK_CONFIG", "CLOUDSDK_CORE_PROJECT",
  "CLOUDSDK_ACTIVE_CONFIG_NAME", "GOOGLE_CLOUD_PROJECT", "AZURE_CONFIG_DIR", "OMP_REVIEW_DIR", "OMP_JEV_PROTECTED_TARGETS",
  "OMP_JEV_ON_EXHAUSTION", "OMP_JEV_FALLBACK_MODELS", "OMP_JEV_PRODUCTION_MIN",
]) delete process.env[name]
process.env.HOME = home
process.env.OMP_JEV_DEBUG = join(root, "audit", "decisions.jsonl")
after(() => rmSync(root, { recursive: true, force: true }))

const verdict = {
  model: "jev-stub",
  answers: {
    dangerousness: { type: "score", score: 0, confidence: 0.99 },
    blast_radius: { type: "score", score: 0, confidence: 0.99 },
    plausible_dev_purpose: { type: "noul", noul: 0.99 },
    production_impact: { type: "noul", noul: 0.01 },
    risk_category: { type: "choice", choice: "routine_or_scoped", confidence: 0.99 },
  },
}

// Enabled tools plus mounted devices, as omp's getActiveTools() reports them.
const ACTIVE = ["read", "bash", "edit", "eval", "write", "task", "ast_edit", "debug", "lsp", "mcp__chrome_devtools_click"]

// Loads the extension against a stub host and returns its tool_call handler.
function load({ active = ACTIVE } = {}) {
  const calls = { jev: 0 }
  let handler
  const pi = {
    on(event, registered) {
      assert.equal(event, "tool_call")
      handler = registered
    },
    getActiveTools() {
      if (active instanceof Error) throw active
      return active
    },
  }
  const requestJev = async () => {
    calls.jev++
    return verdict
  }
  const completeSimple = async () => {
    throw new Error("fallback must not run")
  }
  autoApproveJev(pi, { requestJev, completeSimple })
  const ctx = {
    cwd: "/repo",
    hasUI: false,
    ui: { confirm: async () => false },
    modelRegistry: {
      find: () => undefined,
      getApiKey: async () => undefined,
      getApiKeyForProvider: async () => undefined,
      resolver: () => undefined,
    },
    sessionManager: { getSessionId: () => "test" },
  }
  const call = (toolName, input, toolCallId = "call-1") => handler({ type: "tool_call", toolName, toolCallId, input }, ctx)
  return { calls, call }
}

const device = (name, args) => ({ path: `xd://${name}`, content: typeof args === "string" ? args : JSON.stringify(args) })

test("re-dispatched devices are reviewed once, as the inner tool call", async () => {
  for (const [name, args] of [
    ["lsp", { action: "status" }],
    ["debug", { action: "sessions" }],
    ["mcp__chrome_devtools_click", { uid: "1_2" }],
  ]) {
    const { calls, call } = load()
    // omp order: the loop emits the outer write, then the device dispatch
    // emits the registered tool's own event under the same toolCallId.
    assert.equal(await call("write", device(name, args)), undefined, name)
    assert.equal(calls.jev, 0, `${name}: outer write`)
    assert.equal(await call(name, args), undefined, name)
    assert.equal(calls.jev, 1, `${name}: inner ${name}`)
  }
})

test("self-handled, unknown and non-canonical device writes keep the outer review", async () => {
  const cases = [
    device("report_issue", "write: harness check"),
    device("resolve", "apply staged edit"),
    device("reject", "discard"),
    device("propose", "plan-slug"),
    device("no_such_device", {}),
    device("goal", { op: "get" }),
    { path: "XD://lsp", content: '{"action":"status"}' },
    { path: "[xd://lsp#ABCD]", content: '{"action":"status"}' },
    { path: "xd://lsp/topic", content: '{"action":"status"}' },
    { path: " xd://lsp", content: '{"action":"status"}' },
    { path: "xd://", content: "{}" },
  ]
  for (const input of cases) {
    const { calls, call } = load()
    assert.equal(await call("write", input), undefined, input.path)
    assert.equal(calls.jev, 1, input.path)
  }
})

test("a registered tool shadowing a self-handled device name does not skip review", async () => {
  const { calls, call } = load({ active: [...ACTIVE, "report_issue", "resolve"] })
  await call("write", device("report_issue", "write: harness check"))
  await call("write", device("resolve", "apply"))
  assert.equal(calls.jev, 2)
})

test("an unavailable active-tool list keeps the outer review", async () => {
  const { calls, call } = load({ active: new Error("runtime not initialized") })
  assert.equal(await call("write", device("lsp", { action: "status" })), undefined)
  assert.equal(calls.jev, 1)
})

test("non-device writes are still reviewed", async () => {
  for (const path of ["local://notes.md", "/repo/src/main.ts", "skill://x"]) {
    const { calls, call } = load()
    assert.equal(await call("write", { path, content: "text" }), undefined, path)
    assert.equal(calls.jev, 1, path)
  }
})

const PROD_DESTRUCTIVE = [
  { action: "launch", program: "helm", args: ["uninstall", "api"] },
  { action: "launch", program: "/usr/local/bin/kubectl", args: ["--context", "prod", "delete", "ns", "payments"] },
]

test("infra guard blocks a prod-destructive device action through the inner tool call", async () => {
  for (const args of PROD_DESTRUCTIVE) {
    const { calls, call } = load()
    assert.equal(await call("write", device("debug", args)), undefined, "outer write defers")
    const result = await call("debug", args)
    assert.equal(result?.block, true, args.program)
    assert.match(result.reason, /Do not retry.*ask the user to run it themselves/s)
    assert.equal(calls.jev, 0)
  }
})

test("infra guard blocks a prod-destructive device write that omp does not re-dispatch", async () => {
  for (const args of PROD_DESTRUCTIVE) {
    const { calls, call } = load({ active: ACTIVE.filter((name) => name !== "debug") })
    const result = await call("write", device("debug", args))
    assert.equal(result?.block, true, args.program)
    assert.match(result.reason, /Do not retry.*ask the user to run it themselves/s)
    assert.equal(calls.jev, 0)
  }
})
