#!/usr/bin/env node
// tern-omp-status: read-only comparison of what the checkout declares ("built"
// into this command by Nix) with what is installed and what is observably
// running. It never repairs or restarts anything, and never prints file
// contents, process environments or credentials.
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";

// `launchctl print` output: only the job's own indent-one `state`/`pid` lines
// and `arguments` block (nested `state =` lines are indent two and ignored).
export function parseLaunchctl(text) {
  const job = {state: null, pid: null, args: []};
  let inArgs = false;
  for (const line of text.split("\n")) {
    if (inArgs) {
      if (line === "\t}") inArgs = false;
      else job.args.push(line.trim());
    } else if (line === "\targuments = {") inArgs = true;
    else {
      const m = /^\t(state|pid) = (.+)$/.exec(line);
      if (m) job[m[1]] = m[1] === "pid" ? Number(m[2]) : m[2];
    }
  }
  return job;
}

// The wrapper started by launchd waits while another daemon holds the socket,
// so a live managed job PID is not evidence that the job owns the socket.
export function classifyDaemon(jobPid, ownerPids) {
  if (ownerPids.length === 0) return "none";
  return jobPid != null && ownerPids.includes(jobPid) ? "managed" : "external";
}

const canonical = (v) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );

export function diffMcp(expected, installed) {
  const names = (o) => Object.keys(o);
  return {
    missing: names(expected).filter((n) => !(n in installed)),
    extra: names(installed).filter((n) => !(n in expected)),
    changed: names(expected).filter((n) => n in installed && canonical(expected[n]) !== canonical(installed[n])),
  };
}

const diffList = (expected, installed) => ({
  missing: expected.filter((x) => !installed.includes(x)),
  extra: installed.filter((x) => !expected.includes(x)),
});

function run(cmd, args) {
  try {
    const out = execFileSync(cmd, args, {encoding: "utf8", timeout: 5000, maxBuffer: 1 << 20, stdio: ["ignore", "pipe", "ignore"]});
    return {ok: true, out};
  } catch (error) {
    // A non-zero exit is an answer (for example "no socket owner"); a timeout
    // or a missing executable is not.
    return {ok: false, answered: typeof error.status === "number", out: String(error.stdout ?? "")};
  }
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const when = (ms) => Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z` : "unknown time";

// BSD ps: `lstart` is a fixed 24-character local time, then the command.
function processInfo(pid) {
  const r = run("/bin/ps", ["-o", "lstart=,command=", "-p", String(pid)]);
  if (!r.ok || r.out.trim() === "") return null;
  return {started: Date.parse(r.out.slice(0, 24)), command: r.out.slice(25).trim()};
}

function main(manifestFile) {
  const m = readJson(manifestFile);
  const out = [];
  const say = (s = "") => out.push(s);
  const steps = new Set();
  let problems = 0;
  const bad = (s) => {
    problems++;
    say(`  DRIFT  ${s}`);
  };
  const ok = (s) => say(`  ok     ${s}`);
  const unknown = (s) => say(`  ?      ${s}`);

  say("tern-omp-status: read-only. 'built' = declared by the checkout when this command was built;");
  say("'installed' = files on disk; 'running' = only what processes show without reading their environment.");

  say("\nSource vs build");
  const changed = Object.entries(m.sources).filter(([rel, sha]) => {
    try {
      return sha256(path.join(m.checkout, rel)) !== sha;
    } catch {
      return true;
    }
  });
  if (changed.length === 0) ok(`${Object.keys(m.sources).length} tracked inputs in ${m.checkout} match this build`);
  else {
    for (const [rel] of changed) bad(`${rel} changed or unreadable since this build`);
    say("         Comparisons below use the older build until it is rebuilt.");
    steps.add("Rebuild the pilot from the checkout (nix build --no-link --print-out-paths .#darwinConfigurations.macbook.config.system.build.ternPilot) and run its bin/tern-omp-status.");
  }

  say("\nomp installed config (~/.omp/agent)");
  const agent = path.join(m.home, ".omp/agent");
  const yq = run(process.env.TERN_STATUS_YQ || "yq", ["-o=json", "-I=0", ".extensions", path.join(agent, "config.yml")]);
  let ompDrift = false;
  try {
    if (!yq.ok) throw new Error("unavailable");
    const installed = JSON.parse(yq.out);
    if (!Array.isArray(installed)) throw new Error("not a list");
    const d = diffList(m.omp.extensions.map((e) => e.store), installed);
    const source = Object.fromEntries(m.omp.extensions.map((e) => [e.store, e.source]));
    for (const store of d.missing) bad(`extension not installed: ${source[store]}`);
    for (const store of d.extra) bad(`unmanaged extension installed: ${path.basename(store)}`);
    const gone = installed.filter((s) => !fs.existsSync(s));
    for (const store of gone) bad(`installed extension path is missing: ${path.basename(store)}`);
    if (d.missing.length + d.extra.length + gone.length === 0) ok(`${installed.length} extensions match the build`);
    ompDrift ||= d.missing.length + d.extra.length + gone.length > 0;
  } catch {
    unknown("extensions: config.yml unreadable or yq unavailable");
  }
  try {
    const d = diffMcp(m.omp.mcpServers, readJson(path.join(agent, "mcp.json")).mcpServers ?? {});
    for (const n of d.missing) bad(`MCP server not installed: ${n}`);
    for (const n of d.extra) bad(`unmanaged MCP server installed: ${n}`);
    for (const n of d.changed) bad(`MCP server differs from the build: ${n}`);
    if (d.missing.length + d.extra.length + d.changed.length === 0) ok(`${Object.keys(m.omp.mcpServers).length} MCP servers match the build`);
    ompDrift ||= d.missing.length + d.extra.length + d.changed.length > 0;
  } catch {
    unknown("mcp.json unreadable");
  }
  unknown("running omp sessions: loaded extensions/MCP are not observable from files");
  if (ompDrift || changed.length > 0) steps.add("Apply omp changes: sudo darwin-rebuild switch --flake .#macbook (the full system switch, not the Tern-only activation).");
  steps.add("omp reads extensions at process start: use a fresh omp process; /reload-plugins reconnects MCP servers in an existing one.");

  say("\nTern app");
  const app = m.tern.app;
  let appMtime = null;
  const pb = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(app, "Contents/Info.plist")]);
  try {
    appMtime = fs.statSync(path.join(app, "Contents/MacOS/tern")).mtimeMs;
  } catch {}
  if (pb.ok && /^[0-9][0-9A-Za-z.+-]*$/.test(pb.out.trim()) && appMtime != null) {
    ok(`installed app ${pb.out.trim()} (binary modified ${when(appMtime)})`);
  } else unknown(`${app} is not installed or its version is unreadable`);

  say("\nTern settings (installed ~/Library/Application Support/Tern/settings.json)");
  try {
    const s = readJson(path.join(m.tern.configDir, "settings.json"));
    const wrong = ["keymap", "keymap_prefix"].filter((k) => s[k] !== m.tern.settings[k]);
    const binds = Object.entries(m.tern.settings.keybinds).filter(([k, v]) => s.keybinds?.[k] !== v).map(([k]) => k);
    for (const k of wrong) bad(`${k} differs from the build`);
    if (binds.length) bad(`${binds.length} managed keybindings differ or are missing: ${binds.join(", ")}`);
    if (wrong.length + binds.length === 0) ok(`${Object.keys(m.tern.settings.keybinds).length} managed keybindings match the build`);
    else steps.add("Apply Tern settings only: tern-settings-apply, then use Tern's Reload settings command (no service restart).");
  } catch {
    unknown("settings.json unreadable");
  }
  unknown("running Tern: loaded settings are not observable; Reload settings applies installed ones");

  say("\nTern services (running)");
  const uid = process.getuid();
  const jobs = {};
  for (const label of m.tern.labels) {
    const r = run("/bin/launchctl", ["print", `gui/${uid}/org.nixos.${label}`]);
    if (!r.ok) {
      jobs[label] = null;
      r.answered ? bad(`${label}: not loaded`) : unknown(`${label}: launchctl probe failed`);
      continue;
    }
    jobs[label] = parseLaunchctl(r.out);
    const info = jobs[label].pid != null ? processInfo(jobs[label].pid) : null;
    const detail = `${label}: ${jobs[label].state ?? "unknown state"}${jobs[label].pid != null ? `, pid ${jobs[label].pid}` : ""}${info ? `, started ${when(info.started)}` : ""}`;
    if (jobs[label].state !== "running") bad(detail);
    else say(`  state  ${detail}`);
  }

  const sock = run("/usr/sbin/lsof", ["-t", "--", m.tern.socket]);
  const jobPid = jobs["tern-pilot-daemon"]?.pid ?? null;
  if (!sock.ok && !sock.answered) unknown("daemon.sock owner: lsof probe failed");
  else {
    const owners = sock.out.split("\n").filter(Boolean).map(Number).map((pid) => ({pid, info: processInfo(pid)})).filter((o) => o.info && /\/tern daemon(\s|$)/.test(o.info.command));
    const kind = classifyDaemon(jobPid, owners.map((o) => o.pid));
    const owner = owners[0];
    if (kind === "none") unknown("daemon.sock: no observable daemon owner (absent or process probe failed)");
    else {
      say(`  daemon.sock owner: pid ${owner.pid}, started ${when(owner.info.started)}, ${kind === "managed" ? "the managed launchd job" : "NOT the managed job"}`);
      if (kind === "external") {
        say(jobPid != null ? `         managed job pid ${jobPid} does not own the socket; its wrapper waits while the socket is held.` : "         no managed daemon job is running.");
        say("         The owner's launch origin is not observable from this check.");
      }
      if (appMtime != null && owner.info.started < appMtime) {
        say(`  ?      owner started before the installed app binary changed (${when(appMtime)}); it may run an older build (start time only, version unobservable).`);
        steps.add("Between Tern turns, use Tern's Restart session daemon command to adopt the installed app; restarting may interrupt panes. This command never does it.");
      }
    }
  }

  say("\nNext steps");
  if (steps.size === 0) say("  none from observable state.");
  for (const s of steps) say(`  - ${s}`);
  console.log(out.join("\n"));
  return problems === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    console.error("Usage: tern-omp-status");
    process.exit(2);
  }
  process.exitCode = main(process.argv[2]);
}
