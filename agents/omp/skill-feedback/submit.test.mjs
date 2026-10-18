import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { identifyProcess } from "./process.mjs";
import { setRequestState, submitFeedback } from "./submit.mjs";

const moduleUrl = new URL("./submit.mjs", import.meta.url).href;
const processUrl = new URL("./process.mjs", import.meta.url).href;
const script = fileURLToPath(moduleUrl);

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "skill-feedback-state-"));
  const directory = join(home, ".agents", "local-skills", "fixture");
  const skill = join(directory, "SKILL.md");
  const stateRoot = join(home, "state");
  mkdirSync(directory, { recursive: true });
  writeFileSync(skill, "---\nname: fixture\ndescription: A fixture\n---\n# Fixture\n");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = { home, stateRoot, env: { TERN_PANE: "41" } };
  const input = { skill, experience: "read-only", fromTask: "debugging a local application", context: "A generic local task selected this skill.", improvements: ["Narrow the activation context."] };
  return { home, directory, skill, stateRoot, options, input };
}

const isNote = name => /^[0-9a-f]{64}\.json$/.test(name);

function requestAt(result) {
  return JSON.parse(readFileSync(join(result.notes, "..", "request.json"), "utf8"));
}

function observations(result) {
  return readdirSync(result.notes).filter(isNote).map(name => JSON.parse(readFileSync(join(result.notes, name), "utf8")));
}

function claims(f) {
  return readdirSync(join(f.stateRoot, "claims"));
}

// This test process stands in for a live worker.
const launched = { status: "launched", session: 1, tab: 2, block: 3, workerProcess: identifyProcess() };
const neverLaunch = async () => assert.fail("must not start another worker");

// A worker that captures every pending note, then completes after the user's decision.
async function review(id, options) {
  assert.equal((await setRequestState(id, "awaiting-approval", options)).status, "awaiting-approval");
  return setRequestState(id, "complete", options);
}

async function liveProcess(t) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  await once(child, "spawn");
  const identity = identifyProcess(child.pid);
  assert.ok(identity, "the OS must identify a live child");
  return { identity, exit: async () => {
    child.kill("SIGKILL");
    await once(child, "exit");
  } };
}

// Runs a module in another node process. `done` resolves with its stdout once it exits cleanly.
function node(t, file, args = []) {
  const child = spawn(process.execPath, [file, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", data => { stdout += data; });
  child.stderr.setEncoding("utf8").on("data", data => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`)));
  });
  return { child, done, output: () => stdout };
}

async function until(condition, what) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("several ideas survive coalescing, and aliases cannot start a competing worker", async t => {
  const f = fixture(t);
  let finishStartup;
  let launches = 0;
  const options = { ...f.options, launch: async () => {
    launches++;
    return new Promise(resolve => { finishStartup = resolve; });
  } };
  const first = submitFeedback(f.input, options);
  const alias = join(f.home, "alias");
  symlinkSync(f.directory, alias);
  const improvements = ["Clarify scope.", "Add a valid activation example.", "Add exclusions.", "Remove a redundant discovery step.", "Explain the safe recovery path."];
  const additional = await submitFeedback({ skill: alias, experience: "used", fromTask: "reviewing monitoring workflows", improvements }, options);
  assert.equal(additional.status, "recorded");
  assert.equal(launches, 1);
  assert.ok(existsSync(additional.savedNote));
  const allIdeas = observations(additional).flatMap(note => note.improvements);
  assert.equal(new Set(allIdeas).size, 6);
  for (const improvement of improvements) assert.ok(allIdeas.includes(improvement));
  assert.deepEqual(new Set(observations(additional).map(note => note.fromTask)),
    new Set([f.input.fromTask, "reviewing monitoring workflows"]));
  finishStartup(launched);
  const original = await first;
  assert.equal(original.request, additional.request);
  assert.equal(original.status, "launched");
  const duplicate = await submitFeedback({ ...f.input, fromTask: "a different parent task" }, options);
  assert.equal(duplicate.status, "already-open");
  assert.equal(observations(duplicate).length, 2);
  assert.equal(readdirSync(join(f.stateRoot, "requests")).length, 1);
});

test("local edits do not drop the claim while the worker waits for push approval", async t => {
  const f = fixture(t);
  let launches = 0;
  const options = { ...f.options, launch: async () => { launches++; return launched; } };
  const result = await submitFeedback(f.input, options);
  await setRequestState(result.request, "awaiting-approval", options);
  appendFileSync(f.skill, "\nA useful change pending approval.\n");
  const additional = await submitFeedback({ ...f.input, improvements: ["Also clarify the exclusion."] }, options);
  assert.equal(additional.status, "already-open");
  assert.equal(additional.request, result.request);
  assert.equal(requestAt(additional).status, "awaiting-approval");
  assert.equal(launches, 1);
});

test("completion deduplicates reviewed notes but permits a different improvement or new skill revision", async t => {
  const f = fixture(t);
  let launches = 0;
  const options = { ...f.options, launch: async () => { launches++; return launched; } };
  const first = await submitFeedback(f.input, options);
  assert.equal((await review(first.request, options)).status, "complete");
  const repeated = await submitFeedback(f.input, options);
  assert.equal(repeated.status, "already-reviewed");
  assert.equal(launches, 1);
  const different = await submitFeedback({ ...f.input, improvements: ["Explain a different workflow."] }, options);
  assert.notEqual(different.request, first.request);
  await review(different.request, options);
  appendFileSync(f.skill, "\nA new revision.\n");
  const revised = await submitFeedback(f.input, options);
  assert.equal(revised.status, "launched");
  assert.notEqual(revised.request, first.request);
  assert.equal(launches, 3);
});

test("a read-only review cannot suppress later feedback from actual use", async t => {
  const f = fixture(t);
  let launches = 0;
  const options = { ...f.options, launch: async () => { launches++; return launched; } };
  const readOnly = await submitFeedback(f.input, options);
  await review(readOnly.request, options);
  const used = await submitFeedback({ ...f.input, experience: "used" }, options);
  assert.equal(used.status, "launched");
  assert.notEqual(used.request, readOnly.request);
  assert.equal(launches, 2);
});

test("late notes stay pending until a later proposal round, and completion never reviews them unseen", async t => {
  const f = fixture(t);
  let launches = 0;
  const options = { ...f.options, launch: async () => { launches++; return launched; } };
  const first = await submitFeedback(f.input, options);
  const capture = await setRequestState(first.request, "awaiting-approval", options);
  assert.deepEqual(capture.covered.map(note => [note.improvements, note.new]), [[f.input.improvements, true]]);
  const lateInput = { ...f.input, experience: "used", improvements: ["Document the late case."] };
  const late = await submitFeedback(lateInput, options);
  assert.equal(late.status, "already-open");
  assert.equal(late.request, first.request);

  const refused = await setRequestState(first.request, "complete", options);
  assert.equal(refused.status, "unseen-notes");
  assert.deepEqual(refused.pending.map(note => note.improvements), [lateInput.improvements]);
  assert.equal(requestAt(first).status, "awaiting-approval");
  assert.equal(claims(f).length, 1);
  // Nothing was marked reviewed, so the late note is not reported as reviewed when resubmitted.
  const resubmitted = await submitFeedback(lateInput, options);
  assert.equal(resubmitted.status, "already-open");
  assert.equal(resubmitted.request, first.request);
  assert.equal(observations(resubmitted).length, 2);

  // A second round adds only the late note; the earlier capture stays valid.
  const second = await setRequestState(first.request, "awaiting-approval", options);
  assert.deepEqual(Object.fromEntries(second.covered.map(note => [note.improvements[0], note.new])),
    { [f.input.improvements[0]]: false, [lateInput.improvements[0]]: true });
  const repeat = await setRequestState(first.request, "awaiting-approval", options);
  assert.deepEqual(repeat.covered.map(note => note.new), [false, false]);
  assert.equal((await setRequestState(first.request, "complete", options)).status, "complete");
  assert.equal(claims(f).length, 0);
  assert.equal((await submitFeedback(lateInput, options)).status, "already-reviewed");
  assert.equal((await submitFeedback(f.input, options)).status, "already-reviewed");
  assert.equal(launches, 1);
});

test("concurrent submissions from other processes are never stranded by completion", async t => {
  const f = fixture(t);
  const options = { ...f.options, launch: async () => launched };
  const first = await submitFeedback(f.input, options);
  let capture = await setRequestState(first.request, "awaiting-approval", options);
  const runner = join(f.home, "late.mjs");
  writeFileSync(runner, `import { identifyProcess } from ${JSON.stringify(processUrl)};
import { submitFeedback } from ${JSON.stringify(moduleUrl)};
process.stdout.write("ready\\n");
await new Promise(resolve => process.stdin.once("data", resolve));
process.stdin.destroy();
const result = await submitFeedback({ ...${JSON.stringify(f.input)}, improvements: [process.argv[2]] }, {
  home: ${JSON.stringify(f.home)}, stateRoot: ${JSON.stringify(f.stateRoot)}, env: { TERN_PANE: "41" },
  launch: async () => ({ status: "launched", block: 4, workerProcess: identifyProcess(process.ppid) }),
});
process.stdout.write(JSON.stringify(result));\n`);
  const runs = Array.from({ length: 5 }, (_, index) => node(t, runner, [`Concurrent idea ${index}.`]));
  await until(() => runs.every(run => run.output().startsWith("ready\n")), "submitters to start");
  for (const { child } of runs) child.stdin.end("go\n");
  // Start completing once one late note has landed, so completion races the remaining submitters.
  await until(() => readdirSync(first.notes).filter(isNote).length > 1, "a late note");
  let refusals = 0;
  for (;;) {
    const result = await setRequestState(first.request, "complete", options);
    if (result.status === "complete") break;
    assert.equal(result.status, "unseen-notes");
    refusals++;
    capture = await setRequestState(first.request, "awaiting-approval", options);
  }
  assert.ok(refusals >= 1);
  const receipts = (await Promise.all(runs.map(run => run.done))).map(output => JSON.parse(output.slice(output.indexOf("\n") + 1)));

  const covered = new Set(capture.covered.map(note => note.key));
  const keys = directory => new Set(readdirSync(directory).filter(isNote).map(name => name.slice(0, 64)));
  // Every note in the completed request was captured before completion, and only those are reviewed.
  assert.deepEqual(keys(first.notes), covered);
  assert.deepEqual(new Set(readdirSync(join(f.stateRoot, "completed"))), covered);
  const claim = requestAt(first).claim;
  for (const receipt of receipts) {
    assert.ok(["recorded", "already-open", "launched"].includes(receipt.status), receipt.status);
    assert.equal(dirname(receipt.savedNote), receipt.notes);
    assert.ok(existsSync(receipt.savedNote));
    if (receipt.request === first.request) continue;
    // Arrivals after completion wait, unreviewed, in the single request that now holds the claim.
    assert.equal(readlinkSync(claim), dirname(receipt.notes));
    assert.equal(existsSync(join(f.stateRoot, "completed", basename(receipt.savedNote, ".json"))), false);
  }
  assert.equal(new Set(receipts.map(receipt => receipt.savedNote)).size, receipts.length);
});

test("failed and uncertain launches retain reports and never auto-retry", async t => {
  for (const failure of [new Error("Destination session is missing."), { status: "launch-uncertain", message: "A tab may exist." }]) {
    const f = fixture(t);
    let launches = 0;
    const options = { ...f.options, launch: async () => {
      launches++;
      if (failure instanceof Error) throw failure;
      return failure;
    } };
    const first = await submitFeedback(f.input, options);
    assert.equal(first.status, failure instanceof Error ? "saved-not-launched" : "launch-uncertain");
    assert.ok(first.recovery.endsWith(`--release ${first.request}`));
    assert.equal(statSync(first.document).mode & 0o777, 0o600);
    assert.equal(statSync(first.notes).mode & 0o777, 0o700);
    const second = await submitFeedback({ ...f.input, improvements: ["A second useful change."] }, options);
    assert.equal(second.status, first.status);
    assert.equal(second.request, first.request);
    assert.equal(second.recovery, first.recovery);
    assert.equal(observations(second).length, 2);
    assert.equal(launches, 1);
    // Explicit abandonment, unlike completion, must permit retrying the same report.
    assert.equal((await setRequestState(first.request, "released", options)).status, "released");
    await submitFeedback(f.input, { ...options, launch: async () => { launches++; return launched; } });
    assert.equal(launches, 2);
  }
});

test("a dead worker is reported with its saved note and manual release, never relaunched", async t => {
  const f = fixture(t);
  const worker = await liveProcess(t);
  let launches = 0;
  const options = { ...f.options, launch: async () => { launches++; return { ...launched, workerProcess: worker.identity }; } };
  const first = await submitFeedback(f.input, options);
  await setRequestState(first.request, "awaiting-approval", options);
  assert.equal((await submitFeedback({ ...f.input, improvements: ["While alive."] }, options)).status, "already-open");
  await worker.exit();
  const late = await submitFeedback({ ...f.input, improvements: ["After it exited."] }, options);
  assert.equal(late.status, "worker-gone");
  assert.equal(late.request, first.request);
  assert.equal(dirname(late.savedNote), late.notes);
  assert.ok(existsSync(late.savedNote));
  assert.equal(late.claim, requestAt(first).claim);
  assert.ok(late.recovery.endsWith(`--release ${first.request}`));
  assert.equal(requestAt(late).status, "awaiting-approval");
  assert.equal(claims(f).length, 1);
  assert.equal(launches, 1);
});

test("an interrupted launcher is reported with manual recovery and never relaunched", async t => {
  const f = fixture(t);
  const runner = join(f.home, "launcher.mjs");
  writeFileSync(runner, `import { submitFeedback } from ${JSON.stringify(moduleUrl)};
await submitFeedback(${JSON.stringify(f.input)}, {
  home: ${JSON.stringify(f.home)}, stateRoot: ${JSON.stringify(f.stateRoot)}, env: { TERN_PANE: "41" },
  launch: () => {
    setInterval(() => {}, 1000);
    process.stdout.write("launching\\n");
    return new Promise(() => {});
  },
});\n`);
  const launcher = node(t, runner);
  await until(() => launcher.output() === "launching\n", "the launch to start");
  launcher.child.kill("SIGKILL");
  await assert.rejects(launcher.done);

  let launches = 0;
  const options = { ...f.options, launch: async () => { launches++; return launched; } };
  const blocked = await submitFeedback({ ...f.input, improvements: ["Another idea."] }, options);
  assert.equal(blocked.status, "launch-interrupted");
  assert.equal(requestAt(blocked).status, "launching");
  assert.ok(existsSync(blocked.savedNote));
  assert.equal(observations(blocked).length, 2);
  assert.ok(blocked.recovery.endsWith(`--release ${blocked.request}`));
  assert.equal(claims(f).length, 1);
  assert.equal(launches, 0);
  // Only the manual release permits a new worker.
  await setRequestState(blocked.request, "released", f.options);
  const relaunched = await submitFeedback(f.input, options);
  assert.equal(relaunched.status, "launched");
  assert.notEqual(relaunched.request, blocked.request);
  assert.equal(launches, 1);
});

test("unverifiable launchers and workers are never reported as open", async t => {
  // A launch that could not be confirmed has no verified worker, even once a worker reports in.
  const uncertain = fixture(t);
  const options = { ...uncertain.options, launch: async () => ({ status: "launch-uncertain", block: 3, message: "A tab may exist." }) };
  const first = await submitFeedback(uncertain.input, options);
  assert.equal((await setRequestState(first.request, "awaiting-approval", options)).status, "awaiting-approval");
  const later = await submitFeedback({ ...uncertain.input, improvements: ["Another idea."] }, options);
  assert.equal(later.status, "worker-unverifiable");
  assert.equal(later.request, first.request);
  assert.ok(existsSync(later.savedNote));
  assert.ok(later.recovery.endsWith(`--release ${first.request}`));

  // A request saved by an earlier helper version has no recorded launcher identity.
  const legacy = fixture(t);
  let started, finish;
  const launching = new Promise(resolve => { started = resolve; });
  const pending = submitFeedback(legacy.input, { ...legacy.options, launch: ({ workerId }) => {
    const file = join(legacy.stateRoot, "requests", workerId, "request.json");
    const { submitterProcess: _, ...request } = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify(request));
    started();
    return new Promise(resolve => { finish = resolve; });
  } });
  await launching;
  const blocked = await submitFeedback({ ...legacy.input, improvements: ["Another idea."] }, { ...legacy.options, launch: neverLaunch });
  assert.equal(blocked.status, "launch-unverifiable");
  assert.ok(existsSync(blocked.savedNote));
  assert.ok(blocked.recovery.endsWith(`--release ${blocked.request}`));
  finish(launched);
  assert.equal((await pending).status, "launched");
});

test("a worker cannot recursively submit or update another request", async t => {
  const f = fixture(t);
  const options = { ...f.options, env: { OMP_SKILL_FEEDBACK_WORKER: "some-worker" } };
  await assert.rejects(submitFeedback(f.input, options), /cannot submit feedback/);
  assert.equal(existsSync(f.stateRoot), false);
  const request = await submitFeedback(f.input, { ...f.options, launch: async () => launched });
  await assert.rejects(setRequestState(request.request, "complete", options), /only update its own/);
  assert.equal(requestAt(request).status, "launched");
});

test("a fast worker's capture, approval wait or completion survives startup confirmation", async t => {
  for (const state of ["awaiting-approval", "complete"]) {
    const f = fixture(t);
    let during;
    const options = { ...f.options, launch: async ({ workerId }) => {
      assert.equal((await setRequestState(workerId, "awaiting-approval", f.options)).covered.length, 1);
      if (state === "complete") assert.equal((await setRequestState(workerId, "complete", f.options)).status, "complete");
      else during = await submitFeedback({ ...f.input, improvements: ["Arrives during startup."] }, { ...f.options, launch: neverLaunch });
      return launched;
    } };
    const result = await submitFeedback(f.input, options);
    assert.equal(result.status, "launched");
    assert.equal(requestAt(result).status, state);
    assert.equal(claims(f).length, state === "complete" ? 0 : 1);
    if (state === "complete") {
      assert.equal((await submitFeedback(f.input, { ...f.options, launch: neverLaunch })).status, "already-reviewed");
      continue;
    }
    assert.equal(during.status, "already-open");
    // The confirmed worker identity is recorded, so later notes still find the worker open.
    const after = await submitFeedback({ ...f.input, improvements: ["Arrives later."] }, { ...f.options, launch: neverLaunch });
    assert.equal(after.status, "already-open");
    const again = await setRequestState(result.request, "awaiting-approval", f.options);
    assert.deepEqual(Object.fromEntries(again.covered.map(note => [note.improvements[0], note.new])),
      { [f.input.improvements[0]]: false, "Arrives during startup.": true, "Arrives later.": true });
  }
});

test("an interrupted state change blocks visibly and keeps notes and the claim", async t => {
  const f = fixture(t);
  let launches = 0;
  const options = { ...f.options, launch: async () => { launches++; return launched; } };
  const first = await submitFeedback(f.input, options);
  await setRequestState(first.request, "awaiting-approval", options);
  // A --complete that was killed while holding the skill's state lock.
  const crashed = await liveProcess(t);
  await crashed.exit();
  const lock = `${requestAt(first).claim}.lock`;
  writeFileSync(lock, JSON.stringify({ operation: "complete", request: first.request, process: crashed.identity }));

  const blockedInput = { ...f.input, improvements: ["A blocked idea."] };
  const blocked = await submitFeedback(blockedInput, options);
  assert.equal(blocked.status, "state-locked");
  assert.equal(blocked.lock, lock);
  assert.equal(blocked.lockHolderState, "gone");
  assert.equal(blocked.recovery, `rm ${JSON.stringify(lock)}`);
  assert.notEqual(blocked.request, first.request);
  assert.ok(existsSync(blocked.savedNote));
  for (const status of ["complete", "awaiting-approval", "released"]) {
    const refused = await setRequestState(first.request, status, options);
    assert.equal(refused.status, "state-locked");
    assert.equal(refused.recovery, blocked.recovery);
  }
  assert.equal(requestAt(first).status, "awaiting-approval");
  assert.equal(readlinkSync(requestAt(first).claim), dirname(first.notes));
  assert.deepEqual(readdirSync(join(f.stateRoot, "completed")), []);
  assert.equal(launches, 1);

  rmSync(lock);
  assert.equal((await setRequestState(first.request, "complete", options)).status, "complete");
  // The blocked note was never reviewed, so resubmitting it starts a new review.
  assert.equal((await submitFeedback(blockedInput, options)).status, "launched");
  assert.equal(launches, 2);
});

test("the CLI exits 1 for every non-success receipt", async t => {
  const f = fixture(t);
  const state = join(f.home, "xdg");
  const worker = await liveProcess(t);
  const options = { ...f.options, stateRoot: join(state, "omp", "skill-feedback"), launch: async () => ({ ...launched, workerProcess: worker.identity }) };
  const first = await submitFeedback(f.input, options);
  const env = { ...process.env, HOME: f.home, XDG_STATE_HOME: state, TERN_PANE: "41" };
  delete env.OMP_SKILL_FEEDBACK_WORKER;
  const cli = (args, extra = {}) => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...env, ...extra } });
    return [result.status, result.stdout ? JSON.parse(result.stdout).status : result.stderr];
  };
  const asWorker = { OMP_SKILL_FEEDBACK_WORKER: first.request };
  assert.deepEqual(cli(["--complete", first.request], asWorker), [1, "unseen-notes"]);
  assert.deepEqual(cli(["--await-approval", first.request], asWorker), [0, "awaiting-approval"]);
  await worker.exit();
  const submission = ["--skill", f.skill, "--experience", "used", "--from-task", "checking exit codes", "--improvement", "A late idea."];
  assert.deepEqual(cli(submission), [1, "worker-gone"]);
  assert.deepEqual(cli(["--complete", first.request], asWorker), [1, "unseen-notes"]);
  assert.deepEqual(cli(["--await-approval", first.request], asWorker), [0, "awaiting-approval"]);
  assert.deepEqual(cli(["--complete", first.request], asWorker), [0, "complete"]);
});

test("separate parent processes atomically claim only one worker", async t => {
  const f = fixture(t);
  const runner = join(f.home, "runner.mjs");
  const launches = join(f.home, "launches");
  writeFileSync(runner, `import { appendFileSync } from 'node:fs';
import { identifyProcess } from ${JSON.stringify(processUrl)};
import { submitFeedback } from ${JSON.stringify(moduleUrl)};
const result = await submitFeedback(${JSON.stringify(f.input)}, {
  home: ${JSON.stringify(f.home)}, stateRoot: ${JSON.stringify(f.stateRoot)}, env: { TERN_PANE: "41" },
  launch: async () => {
    appendFileSync(${JSON.stringify(launches)}, 'started\\n');
    await new Promise(resolve => setTimeout(resolve, 200));
    return { status: 'launched', block: 3, workerProcess: identifyProcess(process.ppid) };
  }
});
console.log(JSON.stringify(result));\n`);
  const results = (await Promise.all([1, 2, 3].map(() => node(t, runner).done))).map(output => JSON.parse(output));
  assert.equal(new Set(results.map(result => result.request)).size, 1);
  assert.equal(readFileSync(launches, "utf8"), "started\n");
  assert.equal(readdirSync(join(f.stateRoot, "requests")).length, 1);
  assert.equal(observations(results[0]).length, 1);
});

test("missing experience or attribution and non-Tern callers are rejected before saving or launching", async t => {
  const f = fixture(t);
  const options = { ...f.options, launch: async () => assert.fail("invalid dispatch must not launch") };
  for (const experience of [undefined, "", "read", "inferred"]) {
    await assert.rejects(submitFeedback({ ...f.input, experience }, options), /--experience/);
  }
  for (const fromTask of [undefined, "", "   ", "one task\nanother task"]) {
    await assert.rejects(submitFeedback({ ...f.input, fromTask }, options), /--from-task/);
  }
  await assert.rejects(submitFeedback(f.input, { ...options, env: {} }), /inside a Tern pane/);
  assert.equal(existsSync(f.stateRoot), false);
});
