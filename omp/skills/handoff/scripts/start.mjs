#!/usr/bin/env node
import { accessSync, constants, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
const normalize = value => value.toLowerCase().replace(/[\s._-]+/g, "-");
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function executable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = resolve(directory, name);
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch {}
  }
  throw new Error(`${name} is not on PATH.`);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

function main() {
  const { values } = parseArgs({ options: {
    file: { type: "string" },
    cwd: { type: "string" },
    model: { type: "string" },
    thinking: { type: "string" },
    check: { type: "boolean", default: false },
  } });
  if (!values.file || !values.cwd) throw new Error("Usage: start.mjs --file <handoff.md> --cwd <worktree> [--model <name>] [--thinking <level>] [--check]");
  if (!isAbsolute(values.file) || !isAbsolute(values.cwd)) throw new Error("--file and --cwd must be absolute paths.");
  const file = resolve(values.file);
  const cwd = resolve(values.cwd);
  if (!statSync(cwd).isDirectory()) throw new Error("--cwd is not a directory.");
  if (!statSync(file).isFile() || !readFileSync(file, "utf8").trim()) throw new Error("The handoff document is empty or is not a file.");
  // omp's @file processor skips contents above this boundary.
  if (statSync(file).size > 5 * 1024 * 1024) throw new Error("The handoff exceeds omp's 5 MiB @file limit; shorten it before launching.");

  const omp = executable("omp");
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
        : `Model ${JSON.stringify(request)} is not available in omp's catalog. No session created.`);
    }
    model = matches[0];
    const supportedThinking = model.thinking ?? [];
    if (thinking && thinking !== "auto" && thinking !== "off" && !supportedThinking.includes(thinking)) {
      throw new Error(`${model.selector} does not support thinking ${thinking}. Supported: ${supportedThinking.join(", ") || "off"}`);
    }
  }

  const args = ["--cwd", cwd];
  if (model) args.push("--model", model.selector);
  if (thinking) args.push("--thinking", thinking);
  args.push(`@${file}`);
  const result = { document: file, cwd, model: model?.selector ?? "omp configured default", thinking: thinking ?? "omp configured default" };
  if (values.check) {
    console.log(JSON.stringify({ ...result, status: "validated", freshSession: true }, null, 2));
    return;
  }

  // Overlay only autoResume. All normal safety extensions, skills and model roles remain enabled.
  const directory = mkdtempSync(join(tmpdir(), "omp-handoff-"));
  const config = join(directory, "fresh.yml");
  writeFileSync(config, "autoResume: false\n", { mode: 0o600 });
  args.unshift("--config", config);
  const command = [omp, ...args].map(quote).join(" ");
  if (!process.env.TMUX || !process.env.TMUX_PANE) {
    console.log(JSON.stringify({ ...result, status: "manual", command, config }, null, 2));
    return;
  }

  // tmux execs these arguments directly; never embed the prompt in a shell command or send keys.
  const tmux = executable("tmux");
  const pane = run(tmux, ["split-window", "-h", "-P", "-F", "#{pane_id}", "-t", process.env.TMUX_PANE, "-c", cwd, omp, ...args], cwd);
  console.log(JSON.stringify({ ...result, status: "launched", pane, config }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`${error.message}\nPreserve the handoff document. If launch receipt is uncertain, inspect tmux before retrying; never create a duplicate successor.`);
  process.exitCode = 1;
}
