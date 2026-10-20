// Briefs: fixed, user-owned context for the main omp session (see ../README.md).
//
// The `brief` CLI (brief.sh) writes $XDG_DATA_HOME/briefs/{active,archive}/<KEY>.md;
// this extension only reads them. Their front matter may link a high-level Jira
// epic for the agent to fetch. Selected keys are recorded in the session, so resume restores them.
// Git's local `omp.brief` setting supplies a default when the session has no selection.
// Each prompt re-reads the files and appends them after the base system prompt: edits
// apply on the next message, compaction cannot summarize it away and the cached
// prefix is untouched. Loads touch $XDG_STATE_HOME/briefs/loaded/<KEY>, which
// `brief ls` and `brief prune` read. Subagents never receive briefs.
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
  // High-level Jira epic linked by the front matter.
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

// Splits a brief file into its notes and the Jira epic its front matter links, or
// returns why the front matter is malformed. Front matter is optional: a first line
// "---", blank or "jira: EPIC" lines, then a closing "---". split_brief in brief.sh
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
    if (value && !JIRA_KEY.test(value)) return `'${value}' is not a Jira key`;
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

// Picker and completion text: the linked epic and the first line of the notes.
function describe(brief: Brief | string): string | undefined {
  if (typeof brief === "string") return `malformed: ${brief}`;
  const summary = brief.notes
    .split("\n")
    .map(line => line.trim())
    .find(line => line !== "" && !line.startsWith("#"));
  const parts = [brief.issue, summary].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

// Selected brief KEY: why it cannot be selected (an invalid key, or no active file),
// or its parsed file.
function loadBrief(key: string): string | { brief: Brief | string } {
  if (!KEY.test(key)) return `"${key}" is not a brief key`;
  const text = readText(key);
  if (text === undefined) {
    return existsSync(briefPath(archiveDir, key))
      ? `Brief ${key} is archived (brief restore ${key})`
      : `Brief ${key} does not exist (brief new ${key})`;
  }
  return { brief: parse(text) };
}

function malformed(key: string, problem: string): string {
  return `Brief ${key} is malformed: ${problem} (brief edit ${key})`;
}

const FRONT_MATTER = "Its optional front matter holds only a `jira: EPIC` line between `---` lines.";

// Deterministic for an unchanged file, so the system prompt stays byte-stable between turns.
// A malformed brief shows the agent its error instead of its notes, so it can be repaired in place.
function render(key: string, brief: Brief | string): string {
  const path = briefPath(activeDir, key);
  if (typeof brief === "string") {
    return [
      `<brief key="${key}">`,
      `The user attached this brief to the session, but its file, \`${path}\`, has malformed front matter (${brief}), so its notes are not shown until that is fixed. If you have not mentioned this yet, tell the user. Repair the front matter when they ask or when your own edit broke it. ${FRONT_MATTER}`,
      "</brief>",
    ].join("\n");
  }
  const { issue, notes } = brief;
  const lines = [
    `<brief key="${key}">`,
    "The user attached this brief to the session. It is durable, higher-level context: the larger piece of work this session belongs to and the purpose behind the user's requests. Use it to understand why they ask for things and to keep your choices consistent with that goal; it does not widen the scope of any request.",
    `The user owns this brief's file, \`${path}\`: edit it only when they ask. When you learn something that future sessions of this work will need and the brief lacks, such as a lasting decision, constraint, convention or key resource, suggest adding it; when part of the brief is wrong or outdated, suggest correcting or removing it. Keep the brief short and relevant across sessions: revise existing text rather than appending, and leave out progress, status and details of the current task. ${FRONT_MATTER}`,
  ];
  if (issue) {
    lines.push(
      `This brief links Jira epic ${issue} as additional high-level context only; the epic is not the work item for this session. The user will identify any current Jira work item separately, so never derive task scope or delivery metadata (branches, commits, merge requests, issue updates, or workflow transitions) from this epic. Fetch the epic with the Jira MCP tool (getJiraIssue) before acting on the first relevant request after this brief is attached or restored, and fetch it again after compaction when its details are relevant and no longer in your context.`,
    );
  }
  const text = notes.trim();
  if (text) lines.push("<notes>", text, "</notes>");
  lines.push("</brief>");
  return lines.join("\n");
}

export default function brief(pi: ExtensionAPI): void {
  // Per-session state stays in this closure: child sessions rebind the factory with their own API.
  let current: string[] | undefined;
  let flagPending = true;

  pi.registerFlag("brief", { type: "string", description: "Load briefs by key (comma-separated for multiple)" });

  const showStatus = (ctx: ExtensionContext) =>
    ctx.ui.setStatus("brief", current?.length ? ` ${current.join(", ")}` : undefined);

  // [] records off; undefined means no selection. Decode historical single-key session entries.
  const recorded = (ctx: ExtensionContext): string[] | undefined => {
    let keys: string[] | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        const data = entry.data as { keys?: string[]; key?: string | null } | undefined;
        keys = data?.keys ?? (data?.key ? [data.key] : []);
      }
    }
    return keys;
  };

  const markLoaded = (key: string) => {
    try {
      mkdirSync(loadedDir, { recursive: true });
      writeFileSync(join(loadedDir, key), "");
    } catch (error) {
      pi.logger.warn("brief: could not record the load time", { key, error: String(error) });
    }
  };

  // Problems already reported per malformed brief, so each breakage warns once.
  const reported = new Map<string, string>();
  const trackMalformed = (ctx: ExtensionContext, key: string, brief: Brief | string) => {
    if (typeof brief !== "string") {
      reported.delete(key);
    } else if (reported.get(key) !== brief) {
      reported.set(key, brief);
      ctx.ui.notify(`${malformed(key, brief)}; the agent sees only this error until it is fixed.`, "warning");
    }
  };

  const load = (ctx: ExtensionContext, keys: string[] | undefined, persist = true) => {
    current = keys;
    for (const key of keys ?? []) markLoaded(key);
    if (persist && keys !== undefined) {
      const saved = recorded(ctx);
      if (saved?.length !== keys.length || keys.some((key, i) => saved?.[i] !== key)) {
        pi.appendEntry(ENTRY_TYPE, { keys });
      }
    }
    showStatus(ctx);
  };

  // The --brief flag applies once, to the startup session. `/new` keeps the selection;
  // otherwise restore the saved choice (including off) before consulting the repo default.
  const restore = async (ctx: ExtensionContext, keepCurrent: boolean) => {
    if (ctx.agent.kind !== "main") return;
    const flag = flagPending ? pi.getFlag("brief") : undefined;
    flagPending = false;
    let keys = typeof flag === "string" && flag
      ? [...new Set(flag.split(",").map(key => key.trim()))]
      : keepCurrent ? current : recorded(ctx);
    if (keys === undefined) {
      const result = await pi.exec("git", ["config", "--local", "--get", "omp.brief"], { cwd: ctx.cwd });
      if (result.code === 0 && result.stdout.trim()) {
        keys = [...new Set(result.stdout.trim().split(",").map(key => key.trim()))];
      }
    }
    if (keys === undefined) {
      load(ctx, undefined);
      return;
    }
    const available: string[] = [];
    for (const key of keys) {
      const loaded = loadBrief(key);
      if (typeof loaded === "string") {
        ctx.ui.notify(`${loaded}; not loaded.`, "warning");
        continue;
      }
      trackMalformed(ctx, key, loaded.brief);
      available.push(key);
    }
    // Keep the saved selection while a brief is missing or archived, so resume restores it once the file is back.
    load(ctx, available, available.length === keys.length);
  };

  pi.on("session_start", (_event, ctx) => restore(ctx, false));
  pi.on("session_switch", (event, ctx) => restore(ctx, event.reason === "new"));
  pi.on("session_branch", (_event, ctx) => restore(ctx, false));
  pi.on("session_tree", (_event, ctx) => restore(ctx, false));

  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.agent.kind !== "main" || !current?.length) return;
    const available: string[] = [];
    const prompts: string[] = [];
    for (const key of current) {
      const loaded = loadBrief(key);
      if (typeof loaded === "string") {
        ctx.ui.notify(`${loaded}; unloaded.`, "warning");
        continue;
      }
      trackMalformed(ctx, key, loaded.brief);
      available.push(key);
      markLoaded(key);
      prompts.push(render(key, loaded.brief));
    }
    if (available.length !== current.length) {
      current = available;
      showStatus(ctx);
    }
    if (prompts.length > 0) return { systemPrompt: [...event.systemPrompt, ...prompts] };
  });

  pi.registerCommand("brief", {
    description: "Manage session briefs: /brief [KEY|add KEY|remove KEY|off]",
    getArgumentCompletions: prefix => {
      const match = /^(add|remove)\s+(.*)$/.exec(prefix);
      const action = match?.[1];
      const query = (match?.[2] ?? prefix).toLowerCase();
      if (/\s/.test(query)) return null;
      const items: AutocompleteItem[] = action === "remove"
        ? (current ?? [])
          .filter(key => key.toLowerCase().includes(query))
          .map(key => ({ value: `remove ${key}`, label: key, description: `Unload ${key}` }))
        : activeBriefs()
          .filter(({ key }) => key.toLowerCase().includes(query) && (action !== "add" || !current?.includes(key)))
          .map(item => ({
            value: action ? `${action} ${item.key}` : item.key,
            label: item.key,
            description: describe(item.brief),
          }));
      if (!action) {
        if ("add".startsWith(query)) items.push({ value: "add ", label: "add", description: "Attach another brief" });
        if (current?.length) {
          if ("remove".startsWith(query)) items.push({ value: "remove ", label: "remove", description: "Detach one brief" });
          if ("off".startsWith(query)) items.push({ value: "off", label: "off", description: "Unload all briefs" });
        }
      }
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const match = /^(add|remove)(?:\s+(.*))?$/.exec(args.trim());
      const action = match?.[1] ?? "replace";
      let key = match ? (match[2] ?? "").trim() : args.trim();
      if (!key) {
        const options = action === "remove"
          ? (current ?? []).map(key => {
            const loaded = loadBrief(key);
            return { label: key, description: typeof loaded === "string" ? loaded : describe(loaded.brief) };
          })
          : activeBriefs()
            .filter(({ key }) => action !== "add" || !current?.includes(key))
            .map(item => ({ label: item.key, description: describe(item.brief) }));
        if (action === "replace" && current?.length) options.push({ label: "off", description: "Unload all briefs" });
        if (options.length === 0) {
          ctx.ui.notify(action === "remove" ? "No briefs are loaded." : "No matching active briefs; create one with: brief new KEY", "info");
          return;
        }
        const title = action === "add" ? "Add brief" : action === "remove" ? "Remove brief"
          : current?.length ? `Briefs (loaded: ${current.join(", ")})` : "Load brief";
        const choice = await ctx.ui.select(title, options);
        if (!choice) return;
        key = choice;
      }
      if (action === "replace" && key === "off") {
        load(ctx, []);
        ctx.ui.notify("Unloaded all briefs.", "info");
        return;
      }
      if (action === "remove") {
        if (!current?.includes(key)) {
          ctx.ui.notify(`Brief ${key} is not loaded.`, "info");
          return;
        }
        load(ctx, current.filter(item => item !== key));
        ctx.ui.notify(`Unloaded brief ${key}.`, "info");
        return;
      }
      if (action === "add" && current?.includes(key)) {
        ctx.ui.notify(`Brief ${key} is already loaded.`, "info");
        return;
      }
      const loaded = loadBrief(key);
      const problem = typeof loaded === "string" ? loaded
        : typeof loaded.brief === "string" ? malformed(key, loaded.brief) : undefined;
      if (problem) {
        ctx.ui.notify(problem, "error");
        return;
      }
      load(ctx, action === "add" ? [...(current ?? []), key] : [key]);
      ctx.ui.notify(`Loaded brief ${key}; it applies from your next message.`, "info");
    },
  });
}
