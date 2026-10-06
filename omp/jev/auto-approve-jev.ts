// omp adapter for the Jev permission reviewer. Policy, thresholds, fallback
// chain, env knobs, audit and exhaustion default live in ./permission-review.js
// (vendored from tomasmota/agents' OpenCode auto-approve-jev; no longer synced).
// This adapter only maps omp tool calls onto that permission event and the
// reviewer's decision back onto `tool_call`. It runs before omp's approval
// gate: explicit tool/user deny policies never reach it, and explicit prompt
// policies still prompt after an allow here.
import { createPermissionEvaluator } from "./permission-review.js"
import { requestJev as sharedRequestJev } from "./jev-client.js"

type Model = { provider: string; id: string }
type ModelRegistry = {
  find(provider: string, modelId: string): Model | undefined
  getApiKey(model: Model, sessionId?: string): Promise<string | undefined>
  getApiKeyForProvider(provider: string, sessionId?: string): Promise<string | undefined>
  resolver(model: Model, sessionId?: string): unknown
}
type ToolCallContext = {
  cwd: string
  hasUI: boolean
  ui: { confirm(title: string, message: string): Promise<boolean> }
  modelRegistry: ModelRegistry
  sessionManager?: { getSessionId(): string }
}
type ToolCallEvent = { toolName: string; input: Record<string, unknown> }
type ToolCallResult = { block: true; reason: string } | undefined
type AssistantMessage = { stopReason?: string; content?: Array<{ type: string; text?: string }> }
type CompleteSimple = (
  model: Model,
  context: { messages: Array<{ role: "user"; content: string; timestamp: number }> },
  options: { apiKey: unknown; sessionId?: string },
) => Promise<AssistantMessage>
type RequestJev = (args: Record<string, unknown>) => Promise<unknown>
export type AutoApproveJevDeps = { requestJev?: RequestJev; completeSimple?: CompleteSimple }

// Subagent creation never executes by itself; children inherit the policy
// extensions, so delegation runs without a parent review. Native read-only
// and scheduling tools skip as well. Everything else, including `write`
// (also xd:// device dispatch) and `eval`, is reviewed.
// Membership is checked with `=== true` so inherited keys never match.
export const SKIPPED_TOOLS: Record<string, true> = {
  read: true, grep: true, glob: true, find: true, web_search: true, ask: true, todo: true, wait: true, task: true,
}

// OpenCode's `openai` provider was the ChatGPT subscription; omp names that
// subscription `openai-codex` and reserves `openai` for API keys.
const SUBSCRIPTION_ALIASES: Record<string, string> = { openai: "openai-codex" }
const NO_AUTH = "N/A"

// Primary arguments are passed verbatim (never truncated or re-encoded) so the
// deterministic guard and Jev see exactly what runs.
const PRIMARY_FIELD: Record<string, string> = { bash: "command", eval: "code" }

function flatten(value: unknown, path: string, out: string[]): void {
  if (typeof value === "string") {
    out.push(path ? `${path}: ${value}` : value)
  } else if (Array.isArray(value)) {
    if (value.length === 0) out.push(`${path}: []`)
    value.forEach((item, index) => flatten(item, `${path}[${index}]`, out))
  } else if (value && typeof value === "object") {
    const entries = Object.entries(value)
    if (entries.length === 0 && path) out.push(`${path}: {}`)
    for (const [key, item] of entries) flatten(item, path ? `${path}.${key}` : key, out)
  } else if (value !== undefined) {
    out.push(`${path}: ${JSON.stringify(value)}`)
  }
}

export function permissionResources(toolName: string, input: Record<string, unknown>): string[] {
  const rest: Record<string, unknown> = { ...input }
  const resources: string[] = []
  const primary = Object.hasOwn(PRIMARY_FIELD, toolName) ? PRIMARY_FIELD[toolName] : undefined
  if (primary && typeof rest[primary] === "string") {
    resources.push(rest[primary] as string)
    delete rest[primary]
  }
  // `write xd://<tool>` dispatches JSON arguments; expose them as fields
  // rather than an escaped string so nested commands stay legible.
  if (toolName === "write" && typeof rest.path === "string" && rest.path.startsWith("xd://") && typeof rest.content === "string") {
    try {
      rest.content = JSON.parse(rest.content)
    } catch {}
  }
  flatten(rest, "", resources)
  return resources.length > 0 ? resources : ["{}"]
}

function sessionIdOf(ctx: ToolCallContext): string {
  try {
    return ctx.sessionManager?.getSessionId() || "omp"
  } catch {
    return "omp"
  }
}

async function usableKey(registry: ModelRegistry, model: Model, sessionId: string): Promise<boolean> {
  try {
    return Boolean(await registry.getApiKey(model, sessionId))
  } catch {
    return false
  }
}

// Resolve an exact catalog model with a credential; only an `openai` id with
// no usable credential falls back to the same id under `openai-codex`.
export async function resolveFallbackModel(
  registry: ModelRegistry,
  providerID: string,
  modelID: string,
  sessionId: string,
): Promise<Model> {
  const exact = registry.find(providerID, modelID)
  if (exact && (await usableKey(registry, exact, sessionId))) return exact
  const alias = Object.hasOwn(SUBSCRIPTION_ALIASES, providerID) ? SUBSCRIPTION_ALIASES[providerID] : undefined
  const translated = alias ? registry.find(alias, modelID) : undefined
  if (translated && (await usableKey(registry, translated, sessionId))) return translated
  throw new Error(exact || translated ? "fallback model has no credential" : "fallback model is not in the catalog")
}

async function typesafeKey(registry: ModelRegistry, sessionId: string): Promise<string | undefined> {
  try {
    const key = await registry.getApiKeyForProvider("typesafe", sessionId)
    return key && key !== NO_AUTH ? key : undefined
  } catch {
    return undefined
  }
}

export async function reviewToolCall(
  event: ToolCallEvent,
  ctx: ToolCallContext,
  deps: AutoApproveJevDeps = {},
): Promise<ToolCallResult> {
  if (SKIPPED_TOOLS[event.toolName] === true) return undefined
  const registry = ctx.modelRegistry
  const sessionId = sessionIdOf(ctx)
  const request = deps.requestJev ?? (sharedRequestJev as RequestJev)
  const evaluate = createPermissionEvaluator({
    directory: ctx.cwd,
    // Broker-backed key when omp has one; otherwise the shared client keeps
    // its TYPESAFE_API_KEY / secrets.env resolution.
    requestJev: async (args: Record<string, unknown>) => {
      const apiKey = await typesafeKey(registry, sessionId)
      return request(apiKey ? { ...args, apiKey } : args)
    },
    generate: {
      async text({ model, prompt }: { model: { providerID: string; id: string }; prompt: string }) {
        const resolved = await resolveFallbackModel(registry, model.providerID, model.id, sessionId)
        // `@oh-my-pi/pi-ai` exists only inside omp's host loader (which rewrites
        // this literal onto the bundled copy); a static import would also break
        // Node-based tests that inject `completeSimple`.
        const completeSimple = deps.completeSimple ?? ((await import("@oh-my-pi/pi-ai")).completeSimple as CompleteSimple)
        const response = await completeSimple(
          resolved,
          { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
          { apiKey: registry.resolver(resolved, sessionId), sessionId },
        )
        // Provider error text can echo request details; never forward it.
        if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error("fallback model request failed")
        const text = (response.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("")
        return { text }
      },
    },
  })

  const resources = permissionResources(event.toolName, event.input ?? {})
  const permission: { effect: "ask" | "allow" | "deny"; sessionID: string; action: string; resources: string[]; message?: string } = {
    effect: "ask",
    sessionID: sessionId,
    action: event.toolName,
    resources,
  }
  await evaluate(permission)

  if (permission.effect === "allow") return undefined
  if (permission.effect === "deny") {
    return { block: true, reason: permission.message || "Jev auto-approve blocked this action." }
  }
  if (!ctx.hasUI) {
    return { block: true, reason: "Jev auto-approve requires manual approval, but no interactive UI is available." }
  }
  // Cancellation propagates: an aborted dialog rejects or the runner blocks.
  const approved = await ctx.ui.confirm(
    "Jev auto-approve: manual review",
    [`Tool: ${event.toolName}`, ...resources].join("\n").slice(0, 2000),
  )
  return approved ? undefined : { block: true, reason: "Jev auto-approve: rejected by user." }
}

export default function autoApproveJev(
  pi: { on(event: "tool_call", handler: (event: ToolCallEvent, ctx: ToolCallContext) => Promise<ToolCallResult>): void },
  deps: AutoApproveJevDeps = {},
): void {
  pi.on("tool_call", (event, ctx) => reviewToolCall(event, ctx, deps))
}
