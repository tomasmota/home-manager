import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRoot, createSignal, onCleanup } from "solid-js";

const TUI_PLUGIN_ID = "quota-watch.tui";
const REFRESH_INTERVAL_MS = 60_000;
const QUOTA_CACHE_PATH = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "opencode",
  "quota-watch.json",
);
const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const OPENAI_WHAM_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const WEEKLY_UNIT = 6;
const HOURLY_WARN_THRESHOLD = 30;

interface ZaiLimit {
  type: string;
  unit: number;
  number: number;
  percentage: number;
  nextResetTime: number;
}

interface HourlyQuota {
  percentLeft: number;
  resetLabel: string;
}

interface ProviderQuota {
  percentLeft: number;
  daysLeft: number;
  hourly?: HourlyQuota;
}

interface QuotaView {
  zai?: ProviderQuota;
  openai?: ProviderQuota;
}

function resolveAuthPath(): string {
  const dataHome =
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "auth.json");
}

function readAuth(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(resolveAuthPath(), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function providerEntry(auth: Record<string, unknown>, name: string) {
  const entry = auth[name];
  return typeof entry === "object" && entry !== null
    ? (entry as Record<string, unknown>)
    : undefined;
}

function readZaiKey(): string | undefined {
  const key = providerEntry(readAuth(), "zai-coding-plan")?.key;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

async function fetchZaiQuota(key: string): Promise<QuotaView["zai"]> {
  const response = await fetch(ZAI_QUOTA_URL, {
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as {
    data?: { limits?: ZaiLimit[] };
  };
  const limits = body.data?.limits;
  if (!Array.isArray(limits)) return undefined;
  const isValid = (limit: ZaiLimit): boolean =>
    limit.type === "CREDIT_LIMIT" &&
    typeof limit.percentage === "number" &&
    typeof limit.nextResetTime === "number";
  const weekly = limits.find(
    (limit) =>
      isValid(limit) &&
      limit.unit === WEEKLY_UNIT &&
      limit.number === 1,
  );
  if (!weekly) return undefined;
  const result: ProviderQuota = {
    percentLeft: Math.max(0, 100 - Math.round(weekly.percentage)),
    daysLeft: formatDaysUntil(weekly.nextResetTime),
  };
  // Best-effort 5h window: nearest-resetting CREDIT_LIMIT that isn't weekly.
  const hourlyCandidate = limits
    .filter((limit) => isValid(limit) && limit !== weekly)
    .sort((a, b) => a.nextResetTime - b.nextResetTime)[0];
  if (hourlyCandidate) {
    result.hourly = {
      percentLeft: Math.max(
        0,
        100 - Math.round(hourlyCandidate.percentage),
      ),
      resetLabel: formatShortReset(hourlyCandidate.nextResetTime - Date.now()),
    };
  }
  return result;
}

interface OpenaiWindow {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
  reset_after_seconds?: unknown;
}

function parsePercent(value: unknown): number | undefined {
  const num = typeof value === "string" ? Number(value) : value;
  return typeof num === "number" && Number.isFinite(num) ? num : undefined;
}

function parseSeconds(value: unknown): number | undefined {
  const num = typeof value === "string" ? Number(value) : value;
  return typeof num === "number" && Number.isFinite(num) && num >= 0
    ? num
    : undefined;
}

function splitWindows(
  primary?: OpenaiWindow,
  secondary?: OpenaiWindow,
): { weekly?: OpenaiWindow; hourly?: OpenaiWindow } {
  const candidates = [primary, secondary].filter(
    (w): w is OpenaiWindow =>
      w !== undefined && w !== null && typeof w === "object",
  );
  if (candidates.length === 0) return {};
  const withSize = candidates
    .map((w) => ({ window: w, size: parseSeconds(w.limit_window_seconds) }))
    .filter(
      (entry): entry is { window: OpenaiWindow; size: number } =>
        entry.size !== undefined,
    );
  if (withSize.length === candidates.length && candidates.length === 2) {
    withSize.sort((a, b) => b.size - a.size);
    if (withSize[0].size === withSize[1].size) {
      return { weekly: withSize[0].window };
    }
    return { weekly: withSize[0].window, hourly: withSize[1].window };
  }
  return { weekly: secondary ?? primary };
}

function windowMsLeft(window: OpenaiWindow): number | undefined {
  const resetAt = parseSeconds(window.reset_at);
  if (resetAt !== undefined) {
    return Math.max(0, resetAt * 1000 - Date.now());
  }
  const resetAfter = parseSeconds(window.reset_after_seconds);
  if (resetAfter !== undefined) {
    return Math.max(0, resetAfter * 1000);
  }
  return undefined;
}

function parseWindowPercent(window: OpenaiWindow): number | undefined {
  const used = parsePercent(window.used_percent);
  if (used === undefined) return undefined;
  return Math.max(0, 100 - Math.round(used));
}

async function refreshOpenaiToken(refresh: string): Promise<string | undefined> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: OPENAI_CLIENT_ID,
  }).toString();
  const response = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) return undefined;
  const json = (await response.json()) as { access_token?: string };
  return typeof json.access_token === "string" ? json.access_token : undefined;
}

async function fetchOpenaiQuota(): Promise<QuotaView["openai"]> {
  const entry = providerEntry(readAuth(), "openai");
  if (!entry) return undefined;
  const { access, accountId, refresh, expires } = entry;
  if (
    typeof access !== "string" ||
    typeof accountId !== "string" ||
    typeof refresh !== "string"
  ) {
    return undefined;
  }
  let token = access;
  if (typeof expires !== "number" || expires < Date.now() + 60_000) {
    token = (await refreshOpenaiToken(refresh)) ?? access;
  }
  const response = await fetch(OPENAI_WHAM_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "ChatGPT-Account-Id": accountId,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as {
    rate_limit?: {
      primary_window?: OpenaiWindow;
      secondary_window?: OpenaiWindow;
    };
  };
  const { weekly, hourly } = splitWindows(
    body.rate_limit?.primary_window,
    body.rate_limit?.secondary_window,
  );
  if (!weekly) return undefined;
  const percentLeft = parseWindowPercent(weekly);
  if (percentLeft === undefined) return undefined;
  const weeklyMs = windowMsLeft(weekly);
  if (weeklyMs === undefined) return undefined;
  const result: ProviderQuota = {
    percentLeft,
    daysLeft: Math.max(0, Math.ceil(weeklyMs / 86_400_000)),
  };
  if (hourly) {
    const hourlyPercent = parseWindowPercent(hourly);
    const hourlyMs = windowMsLeft(hourly);
    if (hourlyPercent !== undefined && hourlyMs !== undefined) {
      result.hourly = {
        percentLeft: hourlyPercent,
        resetLabel: formatShortReset(hourlyMs),
      };
    }
  }
  return result;
}

function formatShortReset(msLeft: number): string {
  const minutes = Math.max(0, Math.ceil(msLeft / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.ceil(minutes / 60)}h`;
}

function formatDaysUntil(resetTime: number): number {
  const msLeft = resetTime - Date.now();
  return Math.max(0, Math.ceil(msLeft / 86_400_000));
}

function providerPart(name: string, quota: ProviderQuota): string {
  let part = `${name} ${quota.percentLeft}%·${quota.daysLeft}d`;
  if (quota.hourly && quota.hourly.percentLeft <= HOURLY_WARN_THRESHOLD) {
    part += ` 5h${quota.hourly.percentLeft}%·${quota.hourly.resetLabel}`;
  }
  return part;
}

function QuotaText(props: { quota: QuotaView; theme: TuiThemeCurrent }) {
  const parts: string[] = [];
  if (props.quota.zai) {
    parts.push(providerPart("zai", props.quota.zai));
  }
  if (props.quota.openai) {
    parts.push(providerPart("oai", props.quota.openai));
  }
  if (parts.length === 0) return null;
  const warn = [props.quota.zai, props.quota.openai].some(
    (q) =>
      q !== undefined &&
      (q.percentLeft <= 10 ||
        (q.hourly !== undefined &&
          q.hourly.percentLeft <= HOURLY_WARN_THRESHOLD)),
  );
  return (
    <text fg={warn ? props.theme.warning : props.theme.textMuted}>
      {parts.join("  ")}
    </text>
  );
}

function initializeTui(api: TuiPluginApi): void {
  const [quota, setQuota] = createSignal<QuotaView | undefined>(undefined);

  const refresh = async (): Promise<void> => {
    const next: QuotaView = {};
    const key = readZaiKey();
    if (key) next.zai = await fetchZaiQuota(key);
    next.openai = await fetchOpenaiQuota();
    if (next.zai || next.openai) {
      setQuota(next);
      // Handoffs read this instead of repeating authenticated quota requests.
      void mkdir(dirname(QUOTA_CACHE_PATH), { recursive: true })
        .then(() =>
          writeFile(
            QUOTA_CACHE_PATH,
            JSON.stringify({ generatedAt: Date.now(), ...next }),
          ),
        )
        .catch(() => undefined);
    }
  };

  void refresh();
  const interval = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);

  api.slots.register({
    slots: {
      session_prompt_right(ctx: TuiSlotContext) {
        const current = quota();
        if (!current) return null;
        return <QuotaText quota={current} theme={ctx.theme.current} />;
      },
    },
  });

  onCleanup(() => {
    clearInterval(interval);
  });

  api.lifecycle.onDispose(() => {
    clearInterval(interval);
  });
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  createRoot(() => initializeTui(api));
};

const plugin: TuiPluginModule = {
  id: TUI_PLUGIN_ID,
  tui,
};

export default plugin;
