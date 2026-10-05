#!/usr/bin/env node
// Artificial Analysis free-tier client: cached, compact output, never prints the key.
import { readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const URL_LIST = "https://artificialanalysis.ai/api/v2/language/models/free";
const TTL_MS = 12 * 3600 * 1000; // free tier is rate limited (~100/day)
const CACHE = join(process.env.TMPDIR || tmpdir(), "aa-models-cache.json");

const usage = `usage:
  aa.mjs list [--creator <name>] [--sort intelligence|coding|agentic|price|speed|ttft|cost] [--limit N] [--json]
  aa.mjs get <slug|name-fragment> [--raw]
  aa.mjs compare <a> <b> [...]
  aa.mjs refresh`;

function apiKey() {
  const env = process.env.AA_API_KEY || process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  if (env) return env.trim();
  try {
    return readFileSync(join(homedir(), ".config/artificial-analysis/api-key"), "utf8").trim();
  } catch {
    return null;
  }
}

async function load(force = false) {
  if (!force) {
    try {
      if (Date.now() - statSync(CACHE).mtimeMs < TTL_MS) return JSON.parse(readFileSync(CACHE, "utf8"));
    } catch {}
  }
  const key = apiKey();
  if (!key) {
    console.error(
      "No Artificial Analysis API key. Create a free one at https://artificialanalysis.ai/data-api, then either\n" +
        "export AA_API_KEY=... or save it (mode 0600) to ~/.config/artificial-analysis/api-key. Do not paste it into chat.",
    );
    process.exit(2);
  }
  const res = await fetch(URL_LIST, { headers: { "x-api-key": key } });
  if (!res.ok) {
    console.error(`Artificial Analysis HTTP ${res.status} (429 = daily limit; stale cache is used when present)`);
    try {
      return JSON.parse(readFileSync(CACHE, "utf8"));
    } catch {
      process.exit(3);
    }
  }
  const body = await res.json();
  const data = Array.isArray(body) ? body : body.data;
  if (!Array.isArray(data)) {
    console.error("Unexpected response shape; top-level keys: " + Object.keys(body).join(", "));
    process.exit(4);
  }
  mkdirSync(join(CACHE, ".."), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(data), { mode: 0o600 });
  return data;
}

const pick = (m) => {
  const e = m.evaluations ?? {};
  const p = m.pricing ?? {};
  const perf = m.performance ?? m;
  const cost = m.artificial_analysis_intelligence_index_cost?.total_cost;
  return {
    slug: m.slug,
    name: m.name,
    creator: m.model_creator?.name,
    intelligence: e.artificial_analysis_intelligence_index ?? null,
    coding: e.artificial_analysis_coding_index ?? null,
    agentic: e.artificial_analysis_agentic_index ?? null,
    math: e.artificial_analysis_math_index ?? null,
    price_in: p.price_1m_input_tokens ?? null,
    price_out: p.price_1m_output_tokens ?? null,
    tokens_per_s: perf.median_output_tokens_per_second ?? null,
    ttft_s: perf.median_time_to_first_token_seconds ?? null,
    index_run_cost_usd: cost ?? null,
  };
};

const sorters = {
  intelligence: (r) => -(r.intelligence ?? -1),
  coding: (r) => -(r.coding ?? -1),
  agentic: (r) => -(r.agentic ?? -1),
  price: (r) => r.price_out ?? 1e9,
  speed: (r) => -(r.tokens_per_s ?? -1),
  ttft: (r) => r.ttft_s ?? 1e9,
  cost: (r) => r.index_run_cost_usd ?? 1e9,
};

function find(data, q) {
  const n = q.toLowerCase();
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const nq = norm(q);
  const exact = data.filter((m) => m.slug?.toLowerCase() === n || norm(m.name) === nq);
  if (exact.length) return exact;
  return data.filter((m) => norm(m.slug).includes(nq) || norm(m.name).includes(nq));
}

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v && !v.startsWith("--") ? 2 : 1);
  return v && !v.startsWith("--") ? v : true;
};

if (!cmd || cmd === "-h" || cmd === "--help") {
  console.log(usage);
} else if (cmd === "refresh") {
  const d = await load(true);
  console.log(`cached ${d.length} models`);
} else if (cmd === "list") {
  const creator = flag("--creator");
  const sort = flag("--sort") || "intelligence";
  const limit = Number(flag("--limit") || 25);
  const json = flag("--json");
  if (!sorters[sort]) {
    console.error("unknown sort: " + sort);
    process.exit(1);
  }
  let rows = (await load()).map(pick);
  if (creator) rows = rows.filter((r) => (r.creator ?? "").toLowerCase().includes(String(creator).toLowerCase()));
  rows.sort((a, b) => sorters[sort](a) - sorters[sort](b));
  rows = rows.slice(0, limit);
  if (json) console.log(JSON.stringify(rows, null, 2));
  else console.table(rows.map(({ slug, ...r }) => r));
} else if (cmd === "get" || cmd === "compare") {
  const queries = args.filter((a) => !a.startsWith("--"));
  const raw = args.includes("--raw");
  if (!queries.length) {
    console.error(usage);
    process.exit(1);
  }
  const data = await load();
  const out = [];
  for (const q of queries) {
    const hits = find(data, q);
    if (!hits.length) out.push({ query: q, error: "no match" });
    else if (hits.length > 1 && !hits.every((h) => h.slug === hits[0].slug) && cmd === "get")
      out.push({ query: q, ambiguous: hits.slice(0, 15).map((h) => h.slug) });
    else out.push(raw ? hits[0] : pick(hits[0]));
  }
  console.log(JSON.stringify(cmd === "get" ? out[0] : out, null, 2));
} else {
  console.error(usage);
  process.exit(1);
}
