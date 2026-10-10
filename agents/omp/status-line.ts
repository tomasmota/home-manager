import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";

// The loader shares this module with child factories, but gives each its own API.
const spend = new Map<string, number>();
const listeners = new Set<() => void>();

function incoCost(entries: SessionEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    const message = entry.type === "model_usage" ? entry
      : entry.type === "message" && entry.message.role === "assistant" ? entry.message
      : undefined;
    // Task tool totals include other providers and would double-count child journals.
    if (message?.provider === "inco") total += message.usage?.cost?.total ?? 0;
  }
  return total;
}

async function restoreChildren(dir: string): Promise<void> {
  let files;
  try {
    files = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
    const path = join(dir, file.name);
    // Child sessions persist alongside their own artifact directories.
    const entries = (await readFile(path, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    spend.set(path, incoCost(entries));
    await restoreChildren(path.slice(0, -".jsonl".length));
  }
}

function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(Math.round(tokens));
}

export default function statusLine(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let timer: Timer | undefined;
  let key: string | undefined;
  let childrenDir: string | undefined;
  let lastUsageCost: number | undefined;

  const record = (ctx: ExtensionContext) => {
    const path = ctx.sessionManager.getSessionFile();
    const nextKey = path ? resolve(path) : `memory:${ctx.sessionManager.getSessionId()}`;
    const usageCost = ctx.sessionManager.getUsageStatistics().cost;
    if (key !== nextKey || usageCost !== lastUsageCost) {
      key = nextKey;
      childrenDir = path ? key.slice(0, -".jsonl".length) : undefined;
      lastUsageCost = usageCost;
      spend.set(key, incoCost(ctx.sessionManager.getEntries()));
    }
  };

  const render = () => {
    if (!context || context.agent.kind !== "main") return;
    record(context);
    const usage = context.getContextUsage();
    const window = usage?.contextWindow ?? context.model?.contextWindow;
    const tokens = usage ? compactTokens(usage.tokens) : "?";
    const capacity = window ? compactTokens(window) : "?";
    const parts = [`ctx ${tokens}/${capacity}`];
    let cost = 0;
    for (const [path, amount] of spend) {
      if (path === key || (childrenDir && path.startsWith(`${childrenDir}/`))) cost += amount;
    }
    if (cost > 0) parts.push(`Inco $${cost.toFixed(4)}`);
    context.ui.setStatus("custom-metrics", parts.join(" · "));
  };

  const refresh = (_event: unknown, ctx: ExtensionContext) => {
    context = ctx;
    record(ctx);
    for (const listener of listeners) listener();
  };

  const start = async (_event: unknown, ctx: ExtensionContext) => {
    if (timer) ctx.clearTimer(timer);
    context = ctx;
    lastUsageCost = undefined;
    record(ctx);
    if (ctx.agent.kind === "main" && ctx.hasUI) {
      if (childrenDir) await restoreChildren(childrenDir);
      listeners.add(render);
      render();
      timer = ctx.setInterval(render, 1000);
    }
  };

  pi.on("session_start", start);
  pi.on("session_switch", start);
  pi.on("session_branch", start);
  pi.on("session_tree", refresh);
  pi.on("session_compact", refresh);
  pi.on("model_select", refresh);
  pi.on("message_end", refresh);
  pi.on("agent_end", refresh);
  pi.on("turn_end", refresh);
  pi.on("session_shutdown", (_event, ctx) => {
    record(ctx);
    listeners.delete(render);
    if (timer) ctx.clearTimer(timer);
    for (const listener of listeners) listener();
  });
}
