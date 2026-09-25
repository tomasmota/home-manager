// OpenAI/ChatGPT quota via `codex app-server`.
//
// The previous implementation refreshed OpenCode's own OpenAI OAuth tokens
// directly, but auth.openai.com rotates refresh tokens on every use. By
// discarding the rotated token it eventually invalidated the credential in
// auth.json ("refresh_token_reused"), breaking both this plugin and OpenCode's
// openai provider login. codex owns its own token lifecycle, so asking it for
// rate limits consumes nothing from OpenCode's auth.

import { spawn } from "node:child_process";

export interface HourlyQuota {
  percentLeft: number;
  resetLabel: string;
}

export interface OpenaiQuota {
  percentLeft: number;
  daysLeft: number;
  hourly?: HourlyQuota;
}

interface CodexWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

const CODEX_TIMEOUT_MS = 15_000;
const WEEKLY_WINDOW_MINS = 10_080;
const HOURLY_WINDOW_MINS = 300;

export function formatShortReset(msLeft: number): string {
  const minutes = Math.max(0, Math.ceil(msLeft / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.ceil(minutes / 60)}h`;
}

function toNumber(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

function percentLeft(window: CodexWindow): number | undefined {
  const used = toNumber(window.usedPercent);
  if (used === undefined) return undefined;
  return Math.max(0, 100 - Math.round(used));
}

export function parseCodexQuota(
  result: unknown,
  now = Date.now(),
): OpenaiQuota | undefined {
  const byLimitId = (result as { rateLimitsByLimitId?: unknown } | null | undefined)
    ?.rateLimitsByLimitId;
  if (byLimitId === null || typeof byLimitId !== "object") return undefined;
  const windows: CodexWindow[] = [];
  for (const entry of Object.values(byLimitId as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object") continue;
    const { primary, secondary } = entry as {
      primary?: unknown;
      secondary?: unknown;
    };
    for (const window of [primary, secondary]) {
      if (window !== null && typeof window === "object") {
        windows.push(window as CodexWindow);
      }
    }
  }
  const weekly = windows.find(
    (window) => toNumber(window.windowDurationMins) === WEEKLY_WINDOW_MINS,
  );
  if (!weekly) return undefined;
  const weeklyPercent = percentLeft(weekly);
  const weeklyResetsAt = toNumber(weekly.resetsAt);
  if (weeklyPercent === undefined || weeklyResetsAt === undefined) return undefined;
  const quota: OpenaiQuota = {
    percentLeft: weeklyPercent,
    daysLeft: Math.max(0, Math.ceil((weeklyResetsAt * 1000 - now) / 86_400_000)),
  };
  const hourly = windows.find(
    (window) => toNumber(window.windowDurationMins) === HOURLY_WINDOW_MINS,
  );
  if (hourly) {
    const hourlyPercent = percentLeft(hourly);
    const hourlyResetsAt = toNumber(hourly.resetsAt);
    if (hourlyPercent !== undefined && hourlyResetsAt !== undefined) {
      quota.hourly = {
        percentLeft: hourlyPercent,
        resetLabel: formatShortReset(hourlyResetsAt * 1000 - now),
      };
    }
  }
  return quota;
}

export function requestCodexRateLimits(): Promise<unknown> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("codex", ["app-server"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve(undefined);
      return;
    }
    let buffer = "";
    let settled = false;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), CODEX_TIMEOUT_MS);
    child.on("error", () => finish(undefined));
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newlineAt = buffer.indexOf("\n");
      while (newlineAt >= 0) {
        const line = buffer.slice(0, newlineAt).trim();
        buffer = buffer.slice(newlineAt + 1);
        newlineAt = buffer.indexOf("\n");
        if (!line) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const parsed = message as { id?: unknown; result?: unknown };
        if (parsed.id === 1) {
          finish(parsed.result);
          return;
        }
      }
    });
    child.stdin!.on("error", () => finish(undefined));
    child.stdin!.write(
      `${[
        JSON.stringify({
          method: "initialize",
          id: 0,
          params: {
            clientInfo: {
              name: "quota-watch",
              title: "Quota Watch",
              version: "1.0.0",
            },
          },
        }),
        JSON.stringify({ method: "initialized", params: {} }),
        JSON.stringify({ method: "account/rateLimits/read", id: 1 }),
      ].join("\n")}\n`,
      (error) => {
        if (error) finish(undefined);
      },
    );
  });
}

export async function fetchOpenaiQuota(): Promise<OpenaiQuota | undefined> {
  return parseCodexQuota(await requestCodexRateLimits());
}
