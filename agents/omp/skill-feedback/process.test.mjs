import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { identifyProcess, inspectProcess, processState } from "./process.mjs";

// A child that idles until killed; the test always kills it.
async function idleChild(t) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = new Promise(resolve => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  return { child, exited };
}

test("the current process has a stable live identity", () => {
  const identity = identifyProcess();
  assert.equal(identity.pid, process.pid);
  assert.equal(typeof identity.startedAt, "string");
  assert.notEqual(identity.startedAt, "");
  assert.deepEqual(identifyProcess(process.pid), identity);
  assert.equal(processState(identity), "alive");
});

test("a child is alive until it exits, then it is gone and has no identity", async t => {
  const { child, exited } = await idleChild(t);
  const identity = identifyProcess(child.pid);
  assert.equal(identity.pid, child.pid);
  assert.notDeepEqual(identity, identifyProcess());
  assert.equal(processState(identity), "alive");

  child.kill("SIGKILL");
  await exited;
  assert.equal(processState(identity), "gone");
  assert.equal(identifyProcess(child.pid), null);
  assert.equal(inspectProcess(child.pid).state, "gone");
});

test("a pid whose birth stamp differs is another process", () => {
  const identity = identifyProcess();
  const [kind] = identity.startedAt.split(":", 1);
  assert.equal(processState({ pid: identity.pid, startedAt: `${kind}:not-the-birth-of-this-process` }), "gone");
});

test("a stamp from another source cannot be compared", () => {
  const identity = identifyProcess();
  assert.equal(processState({ pid: identity.pid, startedAt: "elsewhere:1" }), "unknown");
});

test("missing or malformed identities and pids are unknown, never signalled", () => {
  const { startedAt } = identifyProcess();
  const inputs = [undefined, null, "123", 123, [], {}, { pid: process.pid }, { startedAt },
    { pid: String(process.pid), startedAt }, { pid: 0, startedAt }, { pid: -1, startedAt }, { pid: 1.5, startedAt },
    { pid: Number.NaN, startedAt }, { pid: process.pid, startedAt: "" }, { pid: process.pid, startedAt: 5 }];
  for (const input of inputs) assert.equal(processState(input), "unknown", JSON.stringify(input));
  for (const pid of [0, -1, 1.5, Number.NaN, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(identifyProcess(pid), null, String(pid));
    assert.equal(inspectProcess(pid).state, "unknown", String(pid));
  }
});

// Use an actual OS ps behind the failing executable, not a made-up birth stamp.
function probeWithPsDirectories(t, programs, pid) {
  const root = mkdtempSync(join(tmpdir(), "feedback-ps-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const realPs = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map(directory => join(directory, "ps")),
    "/bin/ps", "/usr/bin/ps"].find(path => existsSync(path));
  assert.ok(realPs, "an OS ps must be available");
  const directories = programs.map((source, index) => {
    const directory = join(root, `bin${index}`);
    mkdirSync(directory);
    const path = join(directory, "ps");
    if (source === null) symlinkSync(realPs, path);
    else writeFileSync(path, source, { mode: 0o755 });
    return directory;
  });
  const module = new URL("./process.mjs", import.meta.url).href;
  const code = `import { inspectProcessViaPs } from ${JSON.stringify(module)};
console.log(JSON.stringify(inspectProcessViaPs(${pid === undefined ? "process.pid" : JSON.stringify(pid)})));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: { PATH: directories.join(delimiter) },
  });
  assert.equal(result.status, 0, result.stderr);
  return { pid: result.pid, found: JSON.parse(result.stdout) };
}

const unrunnablePs = "#!/nonexistent/interpreter\n";
const failingPs = `#!${process.execPath}\nprocess.stderr.write("ps: broken\\n"); process.exit(3);\n`;

test("a ps that cannot be executed falls through to a usable OS ps", t => {
  const result = probeWithPsDirectories(t, [unrunnablePs, null]);
  assert.equal(result.found.state, "alive");
  assert.equal(result.found.identity.pid, result.pid);
});

test("a ps that runs and fails is not skipped: the process stays unknown", t => {
  assert.deepEqual(probeWithPsDirectories(t, [failingPs, null]).found, { state: "unknown" });
});

test("the OS ps probe reports an exited child as gone", async t => {
  const { child, exited } = await idleChild(t);
  child.kill("SIGKILL");
  await exited;
  assert.deepEqual(probeWithPsDirectories(t, [unrunnablePs, null], child.pid).found, { state: "gone" });
});
