import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

// A process is identified by its pid plus its birth stamp, because a pid alone can be reused
// after the process exits. The stamp comes from the OS, never from cached metadata:
//   linux:<boot id>:<start ticks>  from /proc, which needs no extra program;
//   ps:<start time>                from ps, used on macOS and where /proc is unavailable.
// Both are exact to what the OS records. The only signal ever sent is signal 0.

const psTimeoutMs = 5_000;
const systemPs = ["/bin/ps", "/usr/bin/ps"];
// An exec failure means that candidate cannot run at all (Nix builds may deny the system ps with EPERM);
// any other outcome comes from a ps that ran and is judged as is.
const execFailures = new Set(["ENOENT", "EACCES", "EPERM", "ENOEXEC", "ENOTDIR"]);

const alive = identity => ({ state: "alive", identity });
const gone = { state: "gone" };
const unknown = { state: "unknown" };

function validPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

function procAvailable() {
  return process.platform === "linux" && existsSync("/proc/self/stat");
}

function probeProc(pid) {
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ESRCH" ? gone : unknown;
  }
  // The command name sits in parentheses and may itself contain spaces or ")".
  const close = stat.lastIndexOf(")");
  const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/);
  // fields[0] is the state (field 3 of proc(5)); fields[19] is starttime (field 22).
  if (fields[0] === "Z" || fields[0] === "X" || fields[0] === "x") return gone;
  if (!/^\d+$/.test(fields[19] ?? "")) return unknown;
  let boot;
  try {
    boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return unknown;
  }
  if (!boot) return unknown;
  // Reading is racy: the process may have exited between the two reads of the same pid.
  return alive({ pid, startedAt: `linux:${boot}:${fields[19]}` });
}

// The ps on PATH comes first (the environment's own, e.g. one from the Nix store), then the system's.
function psCandidates() {
  const found = [];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const path = resolve(directory, "ps");
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) found.push(path);
    } catch {}
  }
  return [...new Set([...found, ...systemPs])];
}

function runPs(binary, pid) {
  return spawnSync(binary, ["-o", "stat=,lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: psTimeoutMs,
    maxBuffer: 64 * 1024,
    // ps prints start times in the local zone and language; pin both so every caller agrees.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
  });
}

/**
 * The portable probe, used wherever /proc is unavailable (exported so hosts with /proc can
 * exercise it too). Like inspectProcess without the signal check; never throws.
 */
export function inspectProcessViaPs(pid) {
  if (!validPid(pid)) return unknown;
  try {
    for (const binary of psCandidates()) {
      const result = runPs(binary, pid);
      if (result.error && execFailures.has(result.error.code)) continue;
      if (result.error || result.signal) return unknown;
      const out = (result.stdout ?? "").trim();
      if (result.status === 1 && !out && !(result.stderr ?? "").trim()) return gone;
      if (result.status !== 0) return unknown;
      // lstart is always "Www Mmm d HH:MM:SS YYYY"; some ps builds print an empty stat column in
      // front of it, so the stamp is matched from the end and the rest is the state, if any.
      const match = /^(.*?)\s*((?:[A-Z][a-z]{2}) (?:[A-Z][a-z]{2})\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/.exec(out.replace(/\s+/g, " "));
      if (!match) return unknown;
      if (match[1].startsWith("Z")) return gone;
      return alive({ pid, startedAt: `ps:${match[2]}` });
    }
  } catch {}
  return unknown;
}

function signalZero(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true; // The process exists but belongs to someone else.
    return undefined;
  }
}

/**
 * Looks at the live OS process `pid`.
 * Returns {state: "alive", identity}, {state: "gone"} (absent, exited or zombie) or
 * {state: "unknown"} (the OS could not say). Never throws.
 */
export function inspectProcess(pid = process.pid) {
  if (!validPid(pid)) return unknown;
  const reachable = signalZero(pid);
  if (reachable === false) return gone;
  if (reachable === undefined) return unknown;
  try {
    return procAvailable() ? probeProc(pid) : inspectProcessViaPs(pid);
  } catch {
    return unknown;
  }
}

/** The identity of a verifiable live process, else null (absent or unverifiable). */
export function identifyProcess(pid = process.pid) {
  const found = inspectProcess(pid);
  return found.state === "alive" ? found.identity : null;
}

/**
 * "alive": the same process is running. "gone": it exited or its pid now belongs to another
 * process. "unknown": the identity is malformed or the OS could not verify it.
 */
export function processState(identity) {
  if (!identity || typeof identity !== "object" || !validPid(identity.pid)
    || typeof identity.startedAt !== "string" || identity.startedAt === "") return "unknown";
  const found = inspectProcess(identity.pid);
  if (found.state !== "alive") return found.state;
  const [recordedKind] = identity.startedAt.split(":", 1);
  const [currentKind] = found.identity.startedAt.split(":", 1);
  // A stamp from another source (another OS, or ps against /proc) is not comparable.
  if (recordedKind !== currentKind) return "unknown";
  return identity.startedAt === found.identity.startedAt ? "alive" : "gone";
}
