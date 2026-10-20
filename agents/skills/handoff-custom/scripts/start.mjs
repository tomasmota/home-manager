#!/usr/bin/env node
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const usage = `Usage: start.mjs --file <handoff.md> --cwd <directory> [--model <name>] [--thinking <level>] [--brief <key[,key...]>] [--check]

Starts a fresh omp session in a new tern pane to the right of $TERN_PANE.
Run it with omp's bash tool inside tern.

  --file <path>       absolute handoff document; omp receives it once as @<path>
  --cwd <path>        absolute working directory of the successor
  --model <name>      omp model phrase or exact selector; a trailing effort word sets --thinking
  --thinking <level>  off, minimal, low, medium, high, xhigh, max or auto
  --brief <keys>      comma-separated active briefs; every brief must already exist and be usable
  --check             validate only; writes no files and opens no pane
  -h, --help          show this help`;
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
const startupTimeoutMs = 15_000;
const normalize = value => value.toLowerCase().replace(/[\s._-]+/g, "-");
// Same rules as brief.sh and brief.ts; omp starts without a brief it cannot load, so refuse here.
const briefKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const jiraKeyPattern = /^[A-Z][A-Z0-9_]+-\d+$/;
let splitAttempted = false;

function executable(name, required = true) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = resolve(directory, name);
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch {}
  }
  if (required) throw new Error(`${name} is not on PATH.`);
}

// Read-only: fails unless active brief KEY exists and its front matter parses. Never reads notes into output.
function checkBrief(key) {
  if (!briefKeyPattern.test(key) || key === "off") {
    throw new Error(`Invalid brief key ${JSON.stringify(key)}: use letters, digits, '.', '_' and '-' ('off' is reserved).`);
  }
  const store = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "briefs");
  let text;
  try {
    text = readFileSync(join(store, "active", `${key}.md`), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(existsSync(join(store, "archive", `${key}.md`))
      ? `Brief ${key} is archived; the user must run \`brief restore ${key}\` first.`
      : `Brief ${key} does not exist.`);
  }
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return;
  let problem = "front matter has no closing ---";
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (line === "---") return;
    if (line === "") continue;
    const value = line.startsWith("jira:") ? line.slice("jira:".length).trim() : undefined;
    if (value === undefined) problem = `unknown front matter line '${line}'`;
    else if (value && !jiraKeyPattern.test(value)) problem = `'${value}' is not a Jira issue key`;
    else continue;
    break;
  }
  throw new Error(`Brief ${key} is malformed: ${problem}; the user must run \`brief edit ${key}\`.`);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

// Read-only: inspects the block's program until it is this omp invocation. Never sends input.
async function confirmStartup(tern, block, successor) {
  const deadline = Date.now() + startupTimeoutMs;
  let seen = "tern reported no program";
  for (;;) {
    const result = spawnSync(tern, ["process", String(block), "--json"], { encoding: "utf8", timeout: 5_000 });
    if (result.status === 0) {
      let child;
      try {
        ({ child } = JSON.parse(result.stdout));
      } catch {}
      if (child === null) {
        throw new Error(`omp exited during startup, so no successor is running. Block ${block} stays open with the error: read it once with \`tern capture ${block} --surfaces\` and report it.`);
      }
      if (child?.argv?.[0] === successor[0] && child.argv.at(-1) === successor.at(-1)) return;
      if (child?.name) seen = `block ${block} is running ${child.name}`;
    } else if (/no block is called/.test(result.stderr ?? "")) {
      throw new Error(`Block ${block} closed during startup: omp exited, so no successor is running.`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Startup not confirmed after ${startupTimeoutMs / 1000} s (${seen}). The successor may still start: read block ${block} once with \`tern capture ${block} --surfaces\`. Do not start another successor.`);
    }
    await sleep(250);
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    file: { type: "string" },
    cwd: { type: "string" },
    model: { type: "string" },
    thinking: { type: "string" },
    brief: { type: "string" },
    check: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  } });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (!values.file || !values.cwd) throw new Error("--file and --cwd are required; see --help.");
  if (!isAbsolute(values.file) || !isAbsolute(values.cwd)) throw new Error("--file and --cwd must be absolute paths.");
  const file = resolve(values.file);
  const cwd = resolve(values.cwd);
  if (!statSync(cwd).isDirectory()) throw new Error("--cwd is not a directory.");
  if (!statSync(file).isFile() || !readFileSync(file, "utf8").trim()) throw new Error("The handoff document is empty or is not a file.");
  // omp's @file processor skips contents above this boundary.
  if (statSync(file).size > 5 * 1024 * 1024) throw new Error("The handoff exceeds omp's 5 MiB @file limit; shorten it before launching.");
  const briefs = values.brief === undefined ? [] : [...new Set(values.brief.split(",").map(key => key.trim()))];
  for (const key of briefs) checkBrief(key);

  const pane = process.env.TERN_PANE ?? "";
  if (!/^\d+$/.test(pane)) {
    throw new Error("This launcher works only inside a tern pane: TERN_PANE is missing. Run it with omp's bash tool in tern.");
  }
  const tern = executable("tern");
  // Read-only: proves the daemon answers and knows this pane before anything is written.
  run(tern, ["process", pane, "--json"]);
  const omp = executable("omp");
  const direnv = executable("direnv", false);
  const shell = userInfo().shell;
  if (!shell || !isAbsolute(shell)) throw new Error("Cannot find your login shell in the user database.");
  if (direnv) {
    const rc = JSON.parse(run(direnv, ["status", "--json"], cwd)).state?.foundRC;
    if (rc && rc.allowed !== 0) {
      throw new Error(`direnv has not allowed ${rc.path}. Ask the user to review it and run \`direnv allow\`.`);
    }
  }

  let request = values.model?.trim();
  let thinking = values.thinking?.toLowerCase();
  const trailing = request?.match(/\s+(off|minimal|low|medium|high|xhigh|max|auto)$/i);
  if (trailing) {
    if (thinking && thinking !== trailing[1].toLowerCase()) throw new Error("Conflicting thinking levels in --model and --thinking.");
    thinking = trailing[1].toLowerCase();
    request = request.slice(0, trailing.index).trim();
  }
  if (values.model !== undefined && !request) throw new Error("--model must name a model.");
  if (thinking && !thinkingLevels.has(thinking)) throw new Error(`Unknown thinking level: ${thinking}`);

  let model;
  if (request) {
    const { models } = JSON.parse(run(omp, ["models", "--json"], cwd));
    const needle = normalize(request);
    const exactSelector = models.filter(item => item.selector.toLowerCase() === request.toLowerCase());
    const exactName = models.filter(item => normalize(item.id) === needle || normalize(item.name) === needle);
    const partial = models.filter(item => normalize(item.selector).includes(needle) || normalize(item.name).includes(needle));
    const matches = exactSelector.length ? exactSelector : exactName.length ? exactName : partial;
    if (matches.length !== 1) {
      throw new Error(matches.length
        ? `Ambiguous model ${JSON.stringify(request)}. Choose an exact selector: ${matches.map(item => item.selector).join(", ")}`
        : `Model ${JSON.stringify(request)} is not in omp's model catalog.`);
    }
    model = matches[0];
    // omp accepts auto and off for every model; other levels must be advertised.
    const supported = model.thinking ?? [];
    if (thinking && thinking !== "auto" && thinking !== "off" && !supported.includes(thinking)) {
      throw new Error(`${model.selector} does not support thinking ${thinking}. Supported: ${supported.join(", ") || "off"}`);
    }
  }

  const result = { document: file, cwd, model: model?.selector ?? "omp configured default", thinking: thinking ?? "omp configured default",
    briefs };
  if (values.check) {
    console.log(JSON.stringify({ ...result, status: "validated" }, null, 2));
    return;
  }

  // Overlay only autoResume. All normal safety extensions, skills and model roles remain enabled.
  const config = join(mkdtempSync(join(tmpdir(), "omp-handoff-")), "fresh.yml");
  writeFileSync(config, "autoResume: false\n", { mode: 0o600 });
  const successor = [omp, "--config", config, "--cwd", cwd];
  if (model) successor.push("--model", model.selector);
  if (thinking) successor.push("--thinking", thinking);
  if (briefs.length > 0) successor.push("--brief", briefs.join(","));
  successor.push(`@${file}`);

  // tern quotes this argv and runs it with `$SHELL -l -c`. The interactive shell adds the
  // rc files (zsh sources secrets.env there) and direnv adds the directory's .envrc, as in
  // a pane where the user types omp. Each step execs, so omp becomes the block's program.
  // The document is an argument, never typed into the pane.
  const command = [shell, "-i", "-c", 'exec "$@"', "omp-handoff", ...(direnv ? [direnv, "exec", cwd] : []), ...successor];
  splitAttempted = true;
  const split = spawnSync(tern, ["split", pane, "right", "--cwd", cwd, "--json", "--", ...command],
    { encoding: "utf8", timeout: 30_000 });
  let created;
  try {
    created = JSON.parse(split.stdout);
  } catch {}
  if (split.status !== 0 || !Number.isInteger(created?.block)) {
    const reason = split.error?.message ?? (split.stderr?.trim() || `exit ${split.status}`);
    throw new Error(`tern split did not report a new block (${reason}). A pane may exist anyway: check \`tern ls --json\` once for it and do not start another successor.`);
  }
  await confirmStartup(tern, created.block, successor);
  console.log(JSON.stringify({ ...result, status: "launched", session: created.session, tab: created.tab,
    block: created.block, config }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(`${error.message}\n${splitAttempted ? "" : "No successor was started. "}The handoff document is intact.`);
  process.exitCode = 1;
}
