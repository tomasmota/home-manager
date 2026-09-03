import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRoot, createSignal, onCleanup } from "solid-js";

const TUI_PLUGIN_ID = "quota-watch.tui";
const REFRESH_INTERVAL_MS = 60_000;
const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const OPENAI_WHAM_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const WEEKLY_UNIT = 6;

interface ZaiLimit {
  type: string;
  unit: number;
  number: number;
  percentage: number;
  nextResetTime: number;
}

interface QuotaView {
  zai?: { percentLeft: number; daysLeft: number };
  openai?: { percentLeft: number; daysLeft: number };
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
  const credit = limits.find(
    (limit) =>
      limit.type === "CREDIT_LIMIT" &&
      limit.unit === WEEKLY_UNIT &&
      limit.number === 1 &&
      typeof limit.percentage === "number" &&
      typeof limit.nextResetTime === "number",
  );
  if (!credit) return undefined;
  return {
    percentLeft: Math.max(0, 100 - Math.round(credit.percentage)),
    daysLeft: formatDaysUntil(credit.nextResetTime),
  };
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

function pickWeeklyWindow(
  primary?: OpenaiWindow,
  secondary?: OpenaiWindow,
): OpenaiWindow | undefined {
  const candidates = [primary, secondary].filter(
    (w): w is OpenaiWindow =>
      w !== undefined && w !== null && typeof w === "object",
  );
  if (candidates.length === 0) return undefined;
  const withSize = candidates
    .map((w) => ({ window: w, size: parseSeconds(w.limit_window_seconds) }))
    .filter(
      (entry): entry is { window: OpenaiWindow; size: number } =>
        entry.size !== undefined,
    );
  if (withSize.length > 0) {
    withSize.sort((a, b) => b.size - a.size);
    return withSize[0].window;
  }
  return secondary ?? primary;
}

function daysUntilReset(window: OpenaiWindow): number | undefined {
  const resetAt = parseSeconds(window.reset_at);
  if (resetAt !== undefined) {
    return Math.max(0, Math.ceil((resetAt * 1000 - Date.now()) / 86_400_000));
  }
  const resetAfter = parseSeconds(window.reset_after_seconds);
  if (resetAfter !== undefined) {
    return Math.max(0, Math.ceil(resetAfter / 86_400));
  }
  return undefined;
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
  const window = pickWeeklyWindow(
    body.rate_limit?.primary_window,
    body.rate_limit?.secondary_window,
  );
  if (!window) return undefined;
  const used = parsePercent(window.used_percent);
  if (used === undefined) return undefined;
  const daysLeft = daysUntilReset(window);
  if (daysLeft === undefined) return undefined;
  return {
    percentLeft: Math.max(0, 100 - Math.round(used)),
    daysLeft,
  };
}

function formatDaysUntil(resetTime: number): number {
  const msLeft = resetTime - Date.now();
  return Math.max(0, Math.ceil(msLeft / 86_400_000));
}

function QuotaText(props: { quota: QuotaView; theme: TuiThemeCurrent }) {
  const parts: string[] = [];
  if (props.quota.zai) {
    parts.push(
      `zai ${props.quota.zai.percentLeft}%·${props.quota.zai.daysLeft}d`,
    );
  }
  if (props.quota.openai) {
    parts.push(
      `oai ${props.quota.openai.percentLeft}%·${props.quota.openai.daysLeft}d`,
    );
  }
  if (parts.length === 0) return null;
  const danger = (props.quota.zai?.percentLeft ?? 100) <= 10 ||
    (props.quota.openai?.percentLeft ?? 100) <= 10;
  return (
    <text fg={danger ? props.theme.warning : props.theme.textMuted}>
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
    if (next.zai || next.openai) setQuota(next);
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