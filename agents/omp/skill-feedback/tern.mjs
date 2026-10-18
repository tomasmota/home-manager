import { accessSync, constants, statSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { inspectProcess } from "./process.mjs";

const SESSION = "skill-improvements";
const WORKER_ENV = "OMP_SKILL_FEEDBACK_WORKER";
const startupTimeoutMs = 15_000;
const maxDocumentBytes = 5 * 1024 * 1024; // omp's @file processor skips larger files.

function executable(name, env, required = true) {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const path = resolve(directory, name);
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch {}
  }
  if (required) throw new Error(`${name} is not on PATH.`);
}

function run(command, args, { cwd, env }) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

function requireAbsolute(value, name) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return resolve(value);
}

function knownIds(created, windowKey) {
  const ids = {};
  for (const key of ["session", "tab", "block"]) if (created?.[key] !== undefined) ids[key] = created[key];
  const window = created?.window ?? (windowKey || undefined);
  if (window !== undefined) ids.window = window;
  return ids;
}

// Read-only: inspects the block's program until it is this omp invocation. Never sends input.
// tern's report is only a candidate: it keeps the child's metadata after the process exits, so
// success needs the OS to confirm that exact pid is alive.
async function confirmStartup(tern, block, expected, windowArgs, env) {
  const deadline = Date.now() + startupTimeoutMs;
  let seen = "tern reported no program";
  for (;;) {
    const result = spawnSync(tern, ["process", String(block), "--json", ...windowArgs],
      { env, encoding: "utf8", timeout: 5_000 });
    if (result.status === 0) {
      let child;
      try {
        ({ child } = JSON.parse(result.stdout));
      } catch {}
      if (child === null) {
        return { ok: false, known: true, message: `omp exited during startup, so no worker is running. Block ${block} stays open with the error; read it once with \`tern capture ${block} --surfaces\`.` };
      }
      if (child?.argv?.[0] === expected[0] && child.argv.at(-1) === expected.at(-1)) {
        const found = inspectProcess(child.pid);
        if (found.state === "alive") return { ok: true, workerProcess: found.identity };
        if (found.state === "gone") {
          return { ok: false, known: true, message: `omp exited during startup, so no worker is running (tern still lists pid ${child.pid}, which the OS no longer has). Block ${block} may stay open with the error; read it once with \`tern capture ${block} --surfaces\`.` };
        }
        seen = `the OS could not verify pid ${child.pid} of block ${block}`;
      } else if (child?.name) seen = `block ${block} is running ${child.name}`;
    } else if (/no block is called/.test(result.stderr ?? "")) {
      return { ok: false, known: true, message: `Block ${block} closed during startup: omp exited, so no worker is running.` };
    }
    if (Date.now() >= deadline) {
      return { ok: false, known: false, message: `Startup not confirmed after ${startupTimeoutMs / 1000} s (${seen}). The worker may still start: read block ${block} once with \`tern capture ${block} --surfaces\`. Do not start another worker.` };
    }
    await sleep(250);
  }
}

/**
 * Starts one omp worker as a new tab of the existing `skill-improvements` tern session.
 * Throws only before any `tern new` attempt; afterwards it returns a status and never retries.
 */
export async function launchWorker({ cwd, document, config, workerId, env = process.env }) {
  if (env[WORKER_ENV]) {
    throw new Error("A skill-feedback worker must not start another worker.");
  }
  if (typeof workerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workerId)) {
    throw new Error("workerId must be a nonempty token of letters, digits, '.', '_' or '-'.");
  }
  cwd = requireAbsolute(cwd, "cwd");
  document = requireAbsolute(document, "document");
  config = requireAbsolute(config, "config");
  if (!statSync(cwd).isDirectory()) throw new Error("cwd is not a directory.");
  const documentStat = statSync(document);
  if (!documentStat.isFile() || documentStat.size === 0) throw new Error("The worker document is empty or is not a file.");
  if (documentStat.size > maxDocumentBytes) throw new Error("The worker document exceeds omp's 5 MiB @file limit.");
  if (!statSync(config).isFile()) throw new Error("config is not a file.");

  const tern = executable("tern", env);
  const omp = executable("omp", env);
  const direnv = executable("direnv", env, false);
  const shell = userInfo().shell;
  if (!shell || !isAbsolute(shell)) throw new Error("Cannot find your login shell in the user database.");
  const envBinary = executable("env", env);

  const windowKey = env.TERN_WINDOW_KEY ?? "";
  const windowArgs = windowKey ? ["--window", windowKey] : [];

  // Read-only. Only an existing, uniquely named session is a valid destination.
  let listing;
  try {
    listing = JSON.parse(run(tern, ["ls", "--json", ...windowArgs], { env }));
  } catch (error) {
    throw new Error(`Cannot list tern sessions: ${error.message}`);
  }
  const sessions = (Array.isArray(listing?.sessions) ? listing.sessions : []).filter(item => item?.name === SESSION);
  if (sessions.length === 0) throw new Error(`No tern session named ${SESSION} exists in the selected window; create it first.`);
  if (sessions.length > 1) throw new Error(`More than one tern session is named ${SESSION} in the selected window.`);

  if (direnv) {
    const rc = JSON.parse(run(direnv, ["status", "--json"], { cwd, env })).state?.foundRC;
    if (rc && rc.allowed !== 0) {
      throw new Error(`direnv has not allowed ${rc.path}. Ask the user to review it and run \`direnv allow\`.`);
    }
  }

  const worker = [omp, "--config", config, "--cwd", cwd, `@${document}`];
  // tern quotes this argv and runs it with `$SHELL -l -c`. The interactive shell adds the rc
  // files and direnv adds the directory's .envrc, as in a pane where the user types omp. The
  // marker is set by env after both so no startup file can override it; each step execs, so
  // omp becomes the block's program. The document is an argument, never typed into the pane.
  const command = [shell, "-i", "-c", 'exec "$@"', "omp-skill-feedback",
    ...(direnv ? [direnv, "exec", cwd] : []), envBinary, `${WORKER_ENV}=${workerId}`, ...worker];

  // From here on a tab may exist whatever happens: never create twice.
  const created = spawnSync(tern, ["new", "tab", SESSION, "--cwd", cwd, "--json", "--keep-open", ...windowArgs, "--", ...command],
    { env, encoding: "utf8", timeout: 30_000 });
  if (created.error && ["ENOENT", "EACCES", "ENOEXEC", "ENOTDIR"].includes(created.error.code)) {
    // The binary could not be executed, so no tab exists. Any other error (timeout, output
    // overflow, signal) can happen after tern created the tab and stays uncertain below.
    return { status: "saved-not-launched", ...(windowKey ? { window: windowKey } : {}),
      message: `tern new could not run (${created.error.message}); no worker was started.` };
  }
  let parsed;
  try {
    parsed = JSON.parse(created.stdout);
  } catch {}
  const ids = knownIds(parsed, windowKey);
  if (created.error || created.status !== 0 || !Number.isInteger(parsed?.block)) {
    const reason = created.error?.message ?? (created.stderr?.trim() || `exit ${created.status}`);
    return { status: "launch-uncertain", ...ids,
      message: `tern new did not report a new block (${reason}). A tab may exist anyway: check \`tern ls --json\` once and do not start another worker.` };
  }

  const startup = await confirmStartup(tern, parsed.block, worker, windowArgs, env);
  if (startup.ok) return { status: "launched", ...ids, workerProcess: startup.workerProcess };
  return { status: startup.known ? "saved-not-launched" : "launch-uncertain", ...ids, message: startup.message };
}
