// Briefs: fixed, user-owned context for the main omp session (see ../README.md).
//
// The `brief` CLI (brief.sh) writes $XDG_DATA_HOME/briefs/{active,archive}/<KEY>.md;
// this extension only reads them. Their front matter may link a Jira issue for the
// agent to fetch. The loaded key is recorded in the session, so resume restores it.
// Each prompt re-reads the file and appends it after the base system prompt: edits
// apply on the next message, compaction cannot summarize it away and the cached
// prefix is untouched. Loads touch $XDG_STATE_HOME/briefs/loaded/<KEY>, which
// `brief ls` and `brief prune` read. Subagents never receive the brief.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";

const ENTRY_TYPE = "dev.tomasmota.brief";
// Same rules as brief.sh; validating also keeps keys from escaping the store.
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

const store = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "briefs");
const activeDir = join(store, "active");
const archiveDir = join(store, "archive");
const loadedDir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "briefs", "loaded");

interface Brief {
  // Jira issue linked by the front matter.
  issue?: string;
  notes: string;
}

interface ActiveBrief {
  key: string;
  lastUsed: number;
  // The parsed file, or why its front matter is malformed.
  brief: Brief | string;
}

function briefPath(dir: string, key: string): string {
  return join(dir, `${key}.md`);
}

// The active brief file KEY, or undefined when it does not exist.
function readText(key: string): string | undefined {
  try {
    return readFileSync(briefPath(activeDir, key), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Splits a brief file into its notes and the Jira issue its front matter links, or
// returns why the front matter is malformed. Front matter is optional: a first line
// "---", blank or "jira: ISSUE" lines, then a closing "---". split_brief in brief.sh
// applies the same rules.
function parse(text: string): Brief | string {
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return { notes: text };
  let issue: string | undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "---") return { issue, notes: lines.slice(i + 1).join("\n") };
    if (line === "") continue;
    if (!line.startsWith("jira:")) return `unknown front matter line '${line}'`;
    const value = line.slice("jira:".length).trim();
    if (value && !JIRA_KEY.test(value)) return `'${value}' is not a Jira issue key`;
    issue = value || undefined;
  }
  return "front matter has no closing ---";
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// Active briefs, most recently loaded or edited first, matching `brief ls`.
function activeBriefs(): ActiveBrief[] {
  let names: string[];
  try {
    names = readdirSync(activeDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const briefs: ActiveBrief[] = [];
  for (const name of names) {
    const key = name.slice(0, -".md".length);
    if (!name.endsWith(".md") || !KEY.test(key)) continue;
    const text = readText(key);
    if (text === undefined) continue;
    const lastUsed = Math.max(mtime(briefPath(activeDir, key)), mtime(join(loadedDir, key)));
    briefs.push({ key, lastUsed, brief: parse(text) });
  }
  return briefs.sort((a, b) => b.lastUsed - a.lastUsed);
}

// Picker and completion text: the linked issue and the first line of the notes.
function describe(brief: Brief | string): string | undefined {
  if (typeof brief === "string") return `malformed: ${brief}`;
  const summary = brief.notes
    .split("\n")
    .map(line => line.trim())
    .find(line => line !== "" && !line.startsWith("#"));
  const parts = [brief.issue, summary].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

// The active brief KEY, or why it cannot be loaded.
function loadBrief(key: string): Brief | string {
  if (!KEY.test(key)) return `"${key}" is not a brief key`;
  const text = readText(key);
  if (text === undefined) {
    return existsSync(briefPath(archiveDir, key))
      ? `Brief ${key} is archived (brief restore ${key})`
      : `Brief ${key} does not exist (brief new ${key})`;
  }
  const brief = parse(text);
  return typeof brief === "string" ? `Brief ${key} is malformed: ${brief} (brief edit ${key})` : brief;
}

// Deterministic for an unchanged file, so the system prompt stays byte-stable between turns.
function render(key: string, { issue, notes }: Brief): string {
  const lines = [
    `<brief key="${key}">`,
    "The user attached this brief to the session. It is fixed, higher-level context: the larger piece of work this session belongs to and the purpose behind the user's requests. Use it to understand why they ask for things and to keep your choices consistent with that goal; it does not widen the scope of any request.",
    "The brief is read-only and owned by the user: never edit or extend it, and never record progress in it.",
  ];
  if (issue) {
    lines.push(
      `This brief links Jira issue ${issue}, where the user keeps the details. Fetch it with the Jira MCP tool (getJiraIssue) before acting on the first request in this session, and fetch it again whenever its details are no longer in your context, for example after compaction.`,
    );
  }
  const text = notes.trim();
  if (text) lines.push("<notes>", text, "</notes>");
  lines.push("</brief>");
  return lines.join("\n");
}

export default function brief(pi: ExtensionAPI): void {
  // Per-session state stays in this closure: child sessions rebind the factory with their own API.
  let current: string | undefined;
  let flagPending = true;

  pi.registerFlag("brief", { type: "string", description: "Load a brief (fixed high-level context) by key" });

  const showStatus = (ctx: ExtensionContext) => ctx.ui.setStatus("brief", current ? `brief ${current}` : undefined);

  // Key recorded on the current branch: a key, null after `/brief off`, undefined when never set.
  const recorded = (ctx: ExtensionContext): string | null | undefined => {
    let key: string | null | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        key = (entry.data as { key?: string | null } | undefined)?.key ?? null;
      }
    }
    return key;
  };

  const markLoaded = (key: string) => {
    try {
      mkdirSync(loadedDir, { recursive: true });
      writeFileSync(join(loadedDir, key), "");
    } catch (error) {
      pi.logger.warn("brief: could not record the load time", { key, error: String(error) });
    }
  };

  const load = (ctx: ExtensionContext, key: string | undefined) => {
    current = key;
    if (key) markLoaded(key);
    if ((recorded(ctx) ?? undefined) !== key) pi.appendEntry(ENTRY_TYPE, { key: key ?? null });
    showStatus(ctx);
  };

  // The --brief flag applies once, to the startup session. `/new` keeps the loaded brief;
  // every other transition uses what the target session recorded.
  const restore = (ctx: ExtensionContext, keepCurrent: boolean) => {
    if (ctx.agent.kind !== "main") return;
    const flag = flagPending ? pi.getFlag("brief") : undefined;
    flagPending = false;
    const key = typeof flag === "string" && flag ? flag : keepCurrent ? current : (recorded(ctx) ?? undefined);
    const brief = key ? loadBrief(key) : undefined;
    if (typeof brief === "string") {
      // Keep the session record: the brief loads again on resume once it is usable.
      current = undefined;
      showStatus(ctx);
      ctx.ui.notify(`${brief}; not loaded.`, "warning");
      return;
    }
    load(ctx, key);
  };

  pi.on("session_start", (_event, ctx) => restore(ctx, false));
  pi.on("session_switch", (event, ctx) => restore(ctx, event.reason === "new"));
  pi.on("session_branch", (_event, ctx) => restore(ctx, false));
  pi.on("session_tree", (_event, ctx) => restore(ctx, false));

  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.agent.kind !== "main" || !current) return;
    const brief = loadBrief(current);
    if (typeof brief === "string") {
      current = undefined;
      showStatus(ctx);
      ctx.ui.notify(`${brief}; unloaded.`, "warning");
      return;
    }
    markLoaded(current);
    return { systemPrompt: [...event.systemPrompt, render(current, brief)] };
  });

  pi.registerCommand("brief", {
    description: "Load a brief (fixed high-level context) into this session: /brief [KEY|off]",
    getArgumentCompletions: prefix => {
      if (/\s/.test(prefix)) return null;
      const query = prefix.toLowerCase();
      const items: AutocompleteItem[] = activeBriefs()
        .filter(({ key }) => key.toLowerCase().includes(query))
        .map(item => ({ value: item.key, label: item.key, description: describe(item.brief) }));
      if (current && "off".startsWith(query)) {
        items.push({ value: "off", label: "off", description: `Unload ${current}` });
      }
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      let key = args.trim();
      if (!key) {
        const briefs = activeBriefs();
        if (briefs.length === 0) {
          ctx.ui.notify("No active briefs; create one with: brief new KEY", "info");
          return;
        }
        const options = briefs.map(item => ({ label: item.key, description: describe(item.brief) }));
        if (current) options.push({ label: "off", description: `Unload ${current}` });
        const choice = await ctx.ui.select(current ? `Brief (loaded: ${current})` : "Load brief", options);
        if (!choice) return;
        key = choice;
      }
      if (key === "off") {
        if (!current) {
          ctx.ui.notify("No brief is loaded.", "info");
          return;
        }
        const previous = current;
        load(ctx, undefined);
        ctx.ui.notify(`Unloaded brief ${previous}.`, "info");
        return;
      }
      const brief = loadBrief(key);
      if (typeof brief === "string") {
        ctx.ui.notify(brief, "error");
        return;
      }
      load(ctx, key);
      ctx.ui.notify(`Loaded brief ${key}; it applies from your next message.`, "info");
    },
  });
}
