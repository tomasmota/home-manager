import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { inspectProcess, processState } from "./process.mjs";
import { launchWorker } from "./tern.mjs";

const systemEnv = (process.env.PATH ?? "").split(delimiter).map(directory => join(directory, "env")).find(path => existsSync(path));

// The fake tern keeps windows of sessions in state.json. Like the real CLI it looks up
// sessions and blocks only in the window it is told with --window (else "default"). A new tab
// runs its command in the background the way tern does, with POSIX sh standing in for the
// user's interactive shell, and the "rc file" of that shell tries to override the worker
// marker. `process` reports the block's child with the pid of that background process; like the
// real CLI, TEST_TERN=cached keeps reporting it after the process has exited.
// Every invocation is recorded in calls.jsonl; creations also in news.jsonl.
const fakeTern = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const root = process.env.TEST_ROOT;
const [command, ...args] = process.argv.slice(2);
appendFileSync(root + "/calls.jsonl", JSON.stringify([command, ...args]) + "\\n");
const state = JSON.parse(readFileSync(root + "/state.json", "utf8"));
const flag = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const window = flag("--window") ?? "default";
const sessions = state.windows[window];
if (!sessions) { console.error("tern: no window " + window); process.exit(1); }
const blocksFile = root + "/blocks.json";
const blocks = existsSync(blocksFile) ? JSON.parse(readFileSync(blocksFile, "utf8")) : {};
if (command === "ls") {
  console.log(JSON.stringify({ sessions: sessions.map((name, id) => ({ id, name, shown: id === 0, tabs: [] })), detached: [] }));
} else if (command === "new") {
  appendFileSync(root + "/news.jsonl", JSON.stringify(args) + "\\n");
  const target = args[1];
  if (args[0] !== "tab" || !sessions.includes(target)) { console.error("tern: no session is called " + target); process.exit(1); }
  if (process.env.TEST_NEW === "fail") { console.error("fixture failure"); process.exit(1); }
  if (process.env.TEST_NEW === "garbage") { console.log("created, probably"); process.exit(0); }
  const [, , , script, ...positional] = args.slice(args.indexOf("--") + 1);
  const child = spawn("/bin/sh", ["-c", script, ...positional], {
    cwd: flag("--cwd"), detached: true, stdio: "ignore", env: { ...process.env, OMP_SKILL_FEEDBACK_WORKER: "set-by-rc" } });
  child.unref();
  blocks["3"] = { window, pid: child.pid };
  writeFileSync(blocksFile, JSON.stringify(blocks));
  // Settle like a pane: until omp has started (or, for an omp that quits, the whole chain has exited).
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const settled = () => exited() || (process.env.TEST_OMP !== "exit-after-start" && existsSync(root + "/started.json"));
  for (let i = 0; i < 100 && !settled(); i++) await new Promise(resolve => setTimeout(resolve, 50));
  if (process.env.TEST_NEW === "overflow") { process.stdout.write("x".repeat(2 * 1024 * 1024)); process.exit(0); }
  console.log(JSON.stringify({ session: 1, tab: 2, block: 3 }));
} else if (command === "process") {
  const block = blocks[args[0]];
  if (block?.window !== window) { console.error("tern process: no block is called " + args[0]); process.exit(1); }
  const started = existsSync(root + "/started.json") ? JSON.parse(readFileSync(root + "/started.json", "utf8")) : null;
  let running = true;
  try { process.kill(block.pid, 0); } catch { running = false; }
  const cached = process.env.TEST_TERN === "cached";
  const child = running || cached
    ? { pid: block.pid, name: started ? "omp" : "sh", argv: started ? started.argv : ["sh"] }
    : null;
  console.log(JSON.stringify({ pane: 3, child }));
} else process.exit(9);
`;
const fakeDirenv = `
import { spawnSync } from "node:child_process";
const [command, ...args] = process.argv.slice(2);
if (command === "status") {
  const foundRC = process.env.TEST_DIRENV === "blocked" ? { allowed: 1, path: process.cwd() + "/.envrc" } : null;
  console.log(JSON.stringify({ state: { foundRC } }));
} else if (command === "exec") {
  const [directory, program, ...rest] = args;
  const result = spawnSync(program, rest, { stdio: "inherit", env: { ...process.env, OMP_SKILL_FEEDBACK_WORKER: "set-by-envrc" } });
  process.exit(result.status ?? 1);
} else process.exit(9);
`;
// omp stays up like the real one; it leaves once the fixture is removed, if nothing killed it.
const fakeOmp = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const documents = args.filter(arg => arg.startsWith("@"));
if (process.env.TEST_OMP === "fail" || documents.length !== 1
  || !readFileSync(documents[0].slice(1), "utf8").includes("feedback mission")) process.exit(5);
writeFileSync(process.env.TEST_ROOT + "/started.json", JSON.stringify({ argv: [process.argv[1], ...args],
  marker: process.env.OMP_SKILL_FEEDBACK_WORKER, cwd: process.cwd(), pid: process.pid }));
if (process.env.TEST_OMP !== "exit-after-start") {
  setInterval(() => { if (!existsSync(process.env.TEST_ROOT + "/state.json")) process.exit(0); }, 100);
}
`;

function fixture(t, { windows = { default: ["personal", "skill-improvements"] }, name = "work" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "feedback-tern-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const cwd = join(root, name);
  mkdirSync(cwd);
  const document = join(cwd, `report ${name}.md`);
  writeFileSync(document, "# Report\n\nA feedback mission.\n");
  const config = join(root, "fresh.yml");
  writeFileSync(config, "autoResume: false\n");
  writeFileSync(join(root, "state.json"), JSON.stringify({ windows }));
  for (const [command, source] of Object.entries({ tern: fakeTern, direnv: fakeDirenv, omp: fakeOmp })) {
    writeFileSync(join(bin, command), `#!${process.execPath}\n${source}`, { mode: 0o700 });
  }
  assert.ok(systemEnv, "env must be available for the subprocess environment");
  symlinkSync(systemEnv, join(bin, "env"));
  // PATH holds only the fakes and env, so a test can never reach the real tern daemon.
  const env = { ...process.env, PATH: bin, TEST_ROOT: root };
  delete env.OMP_SKILL_FEEDBACK_WORKER;
  delete env.TERN_WINDOW_KEY;
  delete env.TERN_PANE;
  const stop = pid => {
    if (inspectProcess(pid).state !== "alive") return;
    for (const target of [-pid, pid]) try { process.kill(target, "SIGKILL"); } catch {}
  };
  const blocks = () => existsSync(join(root, "blocks.json")) ? JSON.parse(readFileSync(join(root, "blocks.json"), "utf8")) : {};
  const started = () => JSON.parse(readFileSync(join(root, "started.json"), "utf8"));
  // Nothing the fake tern started may outlive the test.
  t.after(() => {
    for (const block of Object.values(blocks())) stop(block.pid);
    if (existsSync(join(root, "started.json"))) stop(started().pid);
    rmSync(root, { recursive: true, force: true });
  });
  const lines = file => existsSync(join(root, file))
    ? readFileSync(join(root, file), "utf8").trim().split("\n").map(line => JSON.parse(line))
    : [];
  return { root, bin, cwd, document, config, env, started, blockPid: () => blocks()["3"].pid,
    calls: () => lines("calls.jsonl"), news: () => lines("news.jsonl"),
    launch: (overrides = {}) => launchWorker({ cwd, document, config, workerId: "worker-1", env, ...overrides }) };
}

test("a launch starts omp once in a new tab of the existing session with the marker set last", async t => {
  const context = fixture(t);
  const result = await context.launch();
  const { workerProcess, ...rest } = result;
  assert.deepEqual(rest, { status: "launched", session: 1, tab: 2, block: 3 });
  // The OS confirms the worker: the identity is that of the live process tern reported.
  assert.equal(workerProcess.pid, context.blockPid());
  assert.equal(processState(workerProcess), "alive");
  assert.equal(context.news().length, 1);
  const started = context.started();
  // Neither the shell's startup files nor .envrc can override the marker.
  assert.equal(started.marker, "worker-1");
  assert.equal(started.cwd.endsWith("/work"), true);
  // The launcher only lists, creates a tab and reads the program: no focus, keys or splits.
  assert.deepEqual([...new Set(context.calls().map(call => call[0]))].sort(), ["process", "ls", "new"].sort());
});

test("hostile path names are data: nothing in them runs and omp gets one document argument", async t => {
  const context = fixture(t, { name: "w ' $(touch unowned) `touch unowned2` ; touch unowned3" });
  const result = await context.launch();
  assert.equal(result.status, "launched");
  for (const marker of ["unowned", "unowned2", "unowned3"]) {
    for (const directory of [context.root, context.cwd, process.cwd()]) assert.equal(existsSync(join(directory, marker)), false);
  }
  const started = context.started();
  assert.equal(started.argv.filter(arg => arg.startsWith("@")).length, 1);
  assert.equal(started.argv.at(-1), `@${context.document}`);
  assert.equal(started.argv[started.argv.indexOf("--cwd") + 1], context.cwd);
});

test("a missing session is never created and nothing is started", async t => {
  const context = fixture(t, { windows: { default: ["personal", "work"] } });
  await assert.rejects(context.launch(), /skill-improvements/);
  assert.deepEqual(context.news(), []);
  assert.equal(existsSync(join(context.root, "started.json")), false);
});

test("an ambiguous session name is refused without creating a tab", async t => {
  const context = fixture(t, { windows: { default: ["skill-improvements", "personal", "skill-improvements"] } });
  await assert.rejects(context.launch(), /More than one/);
  assert.deepEqual(context.news(), []);
});

test("TERN_WINDOW_KEY selects the window for listing, creation and startup confirmation", async t => {
  const windows = { default: ["personal"], other: ["skill-improvements"] };
  const withKey = fixture(t, { windows });
  const result = await withKey.launch({ env: { ...withKey.env, TERN_WINDOW_KEY: "other" } });
  assert.equal(result.status, "launched");
  assert.equal(result.window, "other");
  assert.equal(withKey.news().length, 1);

  // An empty key means the default window, where the session does not exist.
  const withoutKey = fixture(t, { windows });
  await assert.rejects(withoutKey.launch({ env: { ...withoutKey.env, TERN_WINDOW_KEY: "" } }), /skill-improvements/);
  assert.deepEqual(withoutKey.news(), []);
});

test("a worker refuses to start another worker", async t => {
  const context = fixture(t);
  await assert.rejects(context.launch({ env: { ...context.env, OMP_SKILL_FEEDBACK_WORKER: "parent" } }), /must not start another worker/);
  assert.deepEqual(context.calls(), []);
});

test("an uncertain creation is reported, keeps what is known and is never retried", async t => {
  const failed = fixture(t);
  const failure = await failed.launch({ env: { ...failed.env, TEST_NEW: "fail" } });
  assert.equal(failure.status, "launch-uncertain");
  assert.match(failure.message, /do not start another worker/);
  assert.equal(failed.news().length, 1);

  const garbage = fixture(t);
  const unclear = await garbage.launch({ env: { ...garbage.env, TEST_NEW: "garbage" } });
  assert.equal(unclear.status, "launch-uncertain");
  assert.equal(garbage.news().length, 1);
});

test("a tab created before tern's output overflows stays uncertain and is not retried", async t => {
  const context = fixture(t);
  const result = await context.launch({ env: { ...context.env, TEST_NEW: "overflow" } });
  // The worker really started, yet the launcher cannot prove it from the broken reply.
  assert.equal(existsSync(join(context.root, "started.json")), true);
  assert.equal(result.status, "launch-uncertain");
  assert.match(result.message, /do not start another worker/);
  assert.equal(context.news().length, 1);
});

test("a worker whose omp exits during startup is not reported as launched", async t => {
  const context = fixture(t);
  const result = await context.launch({ env: { ...context.env, TEST_OMP: "fail" } });
  assert.equal(result.status, "saved-not-launched");
  assert.equal(result.block, 3);
  assert.equal(result.session, 1);
  assert.equal(context.news().length, 1);
});

test("tern's cached metadata for an omp that already exited cannot pass startup", async t => {
  const context = fixture(t);
  const result = await context.launch({ env: { ...context.env, TEST_OMP: "exit-after-start", TEST_TERN: "cached" } });
  // tern still reports the exact omp argv and pid, but the OS no longer has that process.
  const [reported] = context.calls().filter(call => call[0] === "process");
  assert.ok(reported);
  assert.equal(context.started().argv.at(-1), `@${context.document}`);
  assert.equal(inspectProcess(context.blockPid()).state, "gone");
  assert.equal(result.status, "saved-not-launched");
  assert.equal(result.workerProcess, undefined);
  assert.equal(result.block, 3);
  assert.equal(context.news().length, 1);
});

test("an .envrc that direnv has not allowed stops the launch before any tab exists", async t => {
  const context = fixture(t);
  await assert.rejects(context.launch({ env: { ...context.env, TEST_DIRENV: "blocked" } }), /direnv has not allowed/);
  assert.deepEqual(context.news(), []);
});

test("invalid inputs are rejected before tern is contacted", async t => {
  const context = fixture(t);
  await assert.rejects(context.launch({ workerId: "bad id; touch x" }), /workerId/);
  await assert.rejects(context.launch({ document: "relative.md" }), /absolute/);
  await assert.rejects(context.launch({ config: join(context.root, "missing.yml") }));
  assert.deepEqual(context.calls(), []);
});
