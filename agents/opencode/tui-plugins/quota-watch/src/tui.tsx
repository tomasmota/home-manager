import { Plugin } from "@opencode/plugin/tui";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createSignal } from "solid-js";
import { fetchOpenaiQuota, formatShortReset } from "./openaiQuota";

const TUI_PLUGIN_ID = "quota-watch.tui";
const REFRESH_INTERVAL_MS = 60_000;
const QUOTA_CACHE_PATH = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "opencode",
  "quota-watch.json",
);
const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

const WEEKLY_UNIT = 6;
const HOURLY_WARN_THRESHOLD = 30;
const OPENAI_FETCH_INTERVAL_MS = 300_000;

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

function QuotaText(props: { quota: QuotaView; theme: Plugin.Context["theme"] }) {
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
    <text fg={warn ? props.theme.text.feedback.warning.base : props.theme.text.muted}>
      {parts.join("  ")}
    </text>
  );
}

function initializeTui(context: Plugin.Context): () => void {
  const [quota, setQuota] = createSignal<QuotaView | undefined>(undefined);
  let lastOpenai: QuotaView["openai"];
  let openaiFetchedAt = 0;

  const refresh = async (): Promise<void> => {
    const next: QuotaView = {};
    const key = readZaiKey();
    if (key) next.zai = await fetchZaiQuota(key);
    // codex app-server is a full process spawn; poll it less often than z.ai.
    if (Date.now() - openaiFetchedAt >= OPENAI_FETCH_INTERVAL_MS) {
      openaiFetchedAt = Date.now();
      lastOpenai = await fetchOpenaiQuota();
    }
    if (lastOpenai) next.openai = lastOpenai;
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

  const unregister = context.ui.slot({
    append: "prompt.footer.status",
    render: () => {
      const current = quota();
      if (!current) return null;
      return <QuotaText quota={current} theme={context.theme} />;
    },
  });

  return () => {
    clearInterval(interval);
    unregister();
  };
}

export default Plugin.define({
  id: TUI_PLUGIN_ID,
  setup: initializeTui,
});
