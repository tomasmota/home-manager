import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregatePaneStates, createTmuxStatus } from "./tmux-status-core.js";

const user = (text, timestamp = 1) => ({ role: "user", content: text, timestamp });
const assistant = (content, timestamp = 2, stopReason = "stop") => ({
  role: "assistant",
  content: typeof content === "string" ? [{ type: "text", text: content }] : content,
  timestamp,
  stopReason,
});
const toolResult = (text, timestamp) => ({ role: "toolResult", content: [{ type: "text", text }], timestamp });
const turn = (text = "Done.") => [user("Fix the status line", 10), assistant(text, 11)];

const verdict = ({ needs = 0.95, completed = 0.05, outcome = "awaiting_user_input", confidence = 0.9 } = {}) => ({
  model: "jev-test",
  usage: { input_tokens: 12 },
  answers: {
    needs_attention: { type: "noul", noul: needs },
    completed_cleanly: { type: "noul", noul: completed },
    outcome: { type: "choice", choice: outcome, confidence },
  },
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

function jev(response) {
  const fn = async (options) => {
    fn.calls.push(options);
    if (response instanceof Error) throw response;
    return typeof response === "function" ? response(options) : response;
  };
  fn.calls = [];
  return fn;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// A window of panes with the tmux options the wire contract reads and writes.
function createTmux(paneIDs, clients = 0) {
  const panes = new Map(paneIDs.map((id) => [id, {}]));
  const tmux = { panes, window: {}, clients };
  tmux.spawnSync = (command, args) => {
    assert.equal(command, "tmux");
    if (args[0] === "display-message") {
      const format = args.at(-1);
      if (format === "#{pane_tty}") return { status: 0, stdout: `/dev/tty-${args[3]}\n` };
      if (format === "#{window_active_clients}") return { status: 0, stdout: `${tmux.clients}\n` };
      throw new Error(`unexpected format ${format}`);
    }
    if (args[0] === "list-panes") {
      const rows = [...panes].map(([id, options]) => [
        id,
        options["@opencode_pane_status"] ?? "",
        options["@opencode_pane_started_at"] ?? "",
        options["@opencode_pane_duration"] ?? "",
        options["@opencode_pane_updated_at"] ?? "",
        tmux.window["@opencode_status"] ?? "",
        String(tmux.clients),
      ].join("\t"));
      return { status: 0, stdout: rows.join("\n") };
    }
    const commands = [[]];
    for (const arg of args) {
      if (arg === ";") commands.push([]);
      else commands.at(-1).push(arg);
    }
    for (const [name, scope, ...rest] of commands) {
      assert.equal(name, "set-option");
      const unset = rest[0] === "-u";
      if (unset) rest.shift();
      const [, target, option, value] = rest;
      const store = scope === "-p" ? panes.get(target) : tmux.window;
      assert.ok(store, `unknown target ${target}`);
      if (unset) delete store[option];
      else store[option] = value;
    }
    return { status: 0, stdout: "" };
  };
  return tmux;
}

function harness({ tmux = createTmux(["%1"]), pane = "%1", clock = { ms: 1_000_000 }, env = {}, ...runtime } = {}) {
  const timers = [];
  const bells = [];
  const closed = [];
  const diagnostics = [];
  const exits = new Set();
  const core = createTmuxStatus({
    env: {
      TMUX: "/tmp/tmux",
      TMUX_PANE: pane,
      HOME: "/nonexistent-home",
      OMP_JEV_ATTENTION_COOLDOWN_MS: "0",
      ...env,
    },
    spawnSync: tmux.spawnSync,
    openSync: (path) => (path === `/dev/tty-${pane}` ? 7 : assert.fail(`unexpected tty ${path}`)),
    writeSync: (fd) => { bells.push(fd); },
    closeSync: (fd) => { closed.push(fd); },
    stdoutWrite: () => { bells.push("stdout"); },
    now: () => clock.ms,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; },
    onExit: (listener) => exits.add(listener),
    offExit: (listener) => exits.delete(listener),
    appendDiagnostic: async (record) => { diagnostics.push(record); },
    ...runtime,
  });
  // Starts every live debounce timer; the promise ends when classification is applied.
  const fire = () => Promise.all(timers.splice(0).filter((timer) => !timer.cleared).map((timer) => timer.callback()));
  const pending = () => timers.filter((timer) => !timer.cleared).length;
  return { core, tmux, clock, timers, bells, closed, diagnostics, exits, fire, pending };
}

const status = (tmux) => tmux.window["@opencode_status"];
const paneStatus = (tmux, pane = "%1") => tmux.panes.get(pane)["@opencode_pane_status"];

test("only the terminal assistant message of the latest request decides error, aborted or clean", async () => {
  const cases = [
    ["terminal assistant error", [user("Go", 1), assistant("Provider failed", 2, "error")], "error"],
    ["terminal assistant aborted", [user("Go", 1), assistant("Partial", 2, "aborted")], "idle"],
    ["no assistant answered the request", [user("Old", 1), assistant("Old answer", 2), user("New", 3)], "idle"],
    ["previous request failed, latest succeeded", [user("Old", 1), assistant("Boom", 2, "error"), user("New", 3), assistant("Fixed", 4)], "done"],
    ["recoverable tool failure is not an error", [
      user("Go", 1),
      assistant("Trying", 2, "toolUse"),
      toolResult("Error: ENOENT", 3),
      assistant("Recovered and finished", 4),
    ], "done"],
    ["length stop still counts as a finished turn", [user("Go", 1), assistant("Cut off", 2, "length")], "done"],
    ["array order does not override timestamps", [assistant("Fixed", 4), user("New", 3), assistant("Boom", 2, "error"), user("Old", 1)], "done"],
  ];
  for (const [label, messages, expected] of cases) {
    const { core, tmux } = harness({ env: { OMP_JEV_ATTENTION_MODE: "off" } });
    await core.start("s");
    assert.equal(status(tmux), "working", label);
    await core.finish(messages);
    assert.equal(status(tmux), expected, label);
  }
});

test("native errors never reach classification and aborted turns leave no alert", async () => {
  const requestJev = jev(verdict());
  const run = harness({ requestJev });
  await run.core.start("s");
  await run.core.finish([user("Go", 1), assistant("Provider failed", 2, "error")]);
  assert.equal(run.pending(), 0);
  await run.core.start("s");
  await run.core.finish([user("Go", 1), assistant("Stopped", 2, "aborted")]);
  assert.equal(run.pending(), 0);
  assert.equal(requestJev.calls.length, 0);
  assert.equal(run.bells.length, 1);
});

test("overlapping asks and approvals keep waiting until every id resolves", async () => {
  const { core, tmux } = harness({ env: { OMP_JEV_ATTENTION_MODE: "off" } });
  await core.start("s");
  const startedAt = tmux.window["@opencode_started_at"];
  assert.ok(startedAt);

  await core.wait("ask:1");
  await core.wait("approval:1");
  await core.wait("ask:1");
  assert.equal(status(tmux), "waiting");
  await core.resume("ask:1");
  assert.equal(status(tmux), "waiting");
  await core.resume("ask:unknown");
  assert.equal(status(tmux), "waiting");
  await core.resume("approval:1");
  assert.equal(status(tmux), "working");
  // Waiting time belongs to the prompt: the elapsed timer never restarted.
  assert.equal(tmux.window["@opencode_started_at"], startedAt);
  await core.resume("ask:1");
  assert.equal(status(tmux), "working");
});

test("turn end and reset forget outstanding waits", async () => {
  const { core, tmux } = harness({ env: { OMP_JEV_ATTENTION_MODE: "off" } });
  await core.start("s");
  await core.wait("approval:1");
  await core.finish(turn());
  assert.equal(status(tmux), "done");
  await core.resume("approval:1");
  assert.equal(status(tmux), "done");

  await core.start("s");
  await core.wait("ask:a");
  await core.reset("s2", true);
  assert.equal(status(tmux), "working");
  await core.wait("ask:b");
  await core.resume("ask:b");
  assert.equal(status(tmux), "working");
  await core.reset("s2");
  assert.equal(status(tmux), "idle");
  assert.equal(tmux.window["@opencode_started_at"], undefined);
});

test("completion duration is fixed at finish; a classified wait times from classification", async () => {
  const on = harness({ requestJev: jev(verdict()) });
  await on.core.start("s");
  const started = 1000;
  assert.equal(on.tmux.window["@opencode_started_at"], String(started));
  on.clock.ms += 65_000;
  await on.core.finish(turn());
  assert.equal(status(on.tmux), "done");
  assert.equal(on.tmux.window["@opencode_duration"], "01:05");
  assert.equal(on.tmux.window["@opencode_started_at"], undefined);
  on.clock.ms += 30_000;
  await on.fire();
  assert.equal(status(on.tmux), "waiting");
  assert.equal(on.tmux.window["@opencode_started_at"], String(started + 95));
  assert.equal(on.tmux.window["@opencode_duration"], undefined);

  const dry = harness({ env: { OMP_JEV_ATTENTION_MODE: "dry-run" }, requestJev: jev(verdict()) });
  await dry.core.start("s");
  dry.clock.ms += 3_725_000;
  await dry.core.finish(turn());
  dry.clock.ms += 90_000;
  await dry.fire();
  assert.equal(status(dry.tmux), "done");
  assert.equal(dry.tmux.window["@opencode_duration"], "1:02:05");
});

test("a new prompt restarts timing after a classified wait", async () => {
  const run = harness({ requestJev: jev(verdict()) });
  await run.core.start("s");
  await run.core.finish(turn());
  run.clock.ms += 10_000;
  await run.fire();
  assert.equal(status(run.tmux), "waiting");
  run.clock.ms += 50_000;
  await run.core.start("s");
  assert.equal(status(run.tmux), "working");
  assert.equal(run.tmux.window["@opencode_started_at"], String(1000 + 60));
});

test("classification applies only in on mode and only past every threshold", async () => {
  const cases = [
    ["awaiting input", {}, "waiting"],
    ["blocked failure", { outcome: "blocked_failure" }, "error"],
    ["off track", { outcome: "off_track" }, "error"],
    ["clean completion", { outcome: "clean_completion" }, "done"],
    ["uncertain", { outcome: "uncertain" }, "done"],
    ["needs-attention just below minimum", { needs: 0.79 }, "done"],
    ["needs-attention at minimum", { needs: 0.8 }, "waiting"],
    ["completed-cleanly just above maximum", { completed: 0.31 }, "done"],
    ["completed-cleanly at maximum", { completed: 0.3 }, "waiting"],
    ["confidence just below minimum", { confidence: 0.49 }, "done"],
    ["confidence at minimum", { confidence: 0.5 }, "waiting"],
    ["lowered needs minimum", { needs: 0.6 }, "waiting", { OMP_JEV_ATTENTION_NEEDS_MIN: "0.5" }],
    ["out-of-range setting falls back to default", { needs: 0.6 }, "done", { OMP_JEV_ATTENTION_NEEDS_MIN: "5" }],
    ["unrecognised mode keeps classification on", {}, "waiting", { OMP_JEV_ATTENTION_MODE: "garbage" }],
    ["dry-run predicts but never applies", {}, "done", { OMP_JEV_ATTENTION_MODE: "dry-run" }],
    ["OpenCode settings are not inherited", {}, "waiting", {
      OPENCODE_JEV_ATTENTION_MODE: "off",
      OPENCODE_JEV_ATTENTION_NEEDS_MIN: "0.99",
    }],
  ];
  for (const [label, answers, expected, env = {}] of cases) {
    const requestJev = jev(verdict(answers));
    const run = harness({ env, requestJev });
    await run.core.start("s");
    await run.core.finish(turn());
    assert.equal(status(run.tmux), "done", `${label}: completion is shown first`);
    await run.fire();
    assert.equal(status(run.tmux), expected, label);
    assert.equal(requestJev.calls.length, 1, label);
  }

  const dry = harness({ env: { OMP_JEV_ATTENTION_MODE: "dry-run" }, requestJev: jev(verdict({ outcome: "blocked_failure" })) });
  await dry.core.start("s");
  await dry.core.finish(turn());
  await dry.fire();
  assert.equal(dry.diagnostics[0].predictedState, "error");
  assert.equal(dry.diagnostics[0].appliedState, "done");
});

test("off mode neither schedules nor calls Jev", async () => {
  const requestJev = jev(verdict());
  const run = harness({ env: { OMP_JEV_ATTENTION_MODE: "off" }, requestJev });
  await run.core.start("s");
  await run.core.finish(turn());
  assert.equal(run.timers.length, 0);
  assert.equal(requestJev.calls.length, 0);
  assert.equal(status(run.tmux), "done");
});

test("unavailable or malformed classifier results fail open to a normal done", async () => {
  const bad = (mutate) => {
    const response = verdict();
    mutate(response);
    return response;
  };
  const responses = [
    new Error("offline"),
    null,
    {},
    bad((r) => { r.answers.needs_attention.noul = 1.2; }),
    bad((r) => { r.answers.needs_attention.noul = -0.1; }),
    bad((r) => { r.answers.needs_attention.noul = "0.9"; }),
    bad((r) => { r.answers.needs_attention.noul = Number.NaN; }),
    bad((r) => { r.answers.completed_cleanly.noul = 3; }),
    bad((r) => { r.answers.outcome.choice = "super_urgent"; }),
    bad((r) => { r.answers.outcome.choice = "error"; }),
    bad((r) => { r.answers.outcome.confidence = 2; }),
    bad((r) => { delete r.answers.outcome; }),
    bad((r) => { delete r.model; }),
  ];
  for (const response of responses) {
    const run = harness({ requestJev: jev(response) });
    await run.core.start("s");
    await run.core.finish(turn());
    await run.fire();
    assert.equal(status(run.tmux), "done", JSON.stringify(response));
    assert.equal(run.diagnostics.length, 1);
    assert.equal(run.diagnostics[0].event, "failure");
  }

  // A transcript with nothing to classify is logged, not sent.
  const requestJev = jev(verdict());
  const run = harness({ requestJev });
  await run.core.start("s");
  await run.core.finish([assistant("No request in this run")]);
  await run.fire();
  assert.equal(requestJev.calls.length, 0);
  assert.equal(status(run.tmux), "done");
  assert.equal(run.diagnostics[0].event, "failure");
});

test("classifier input is the latest request and its final assistant text, bounded and untrusted", async () => {
  const requestJev = jev(verdict({ outcome: "clean_completion" }));
  const run = harness({ requestJev });
  await run.core.start("s");
  await run.core.finish([
    user("Old task OLD-REQUEST", 1),
    assistant("Old reply OLD-REPLY", 2),
    user("Fix the tmux status", 3),
    assistant([{ type: "thinking", thinking: "SECRET-THINKING" }, { type: "text", text: "Calling tools" }], 4, "toolUse"),
    toolResult("TOOL-OUTPUT", 5),
    assistant([{ type: "thinking", thinking: "SECRET-THINKING" }, { type: "text", text: "Done fixing." }], 6),
  ]);
  await run.fire();
  const { state } = requestJev.calls[0];
  assert.equal(state.latest_user_request, "Fix the tmux status");
  assert.equal(state.final_assistant_message, "Done fixing.");
  const sent = JSON.stringify(requestJev.calls[0]);
  for (const leaked of ["OLD-REQUEST", "OLD-REPLY", "SECRET-THINKING", "TOOL-OUTPUT", "Calling tools"]) {
    assert.ok(!sent.includes(leaked), leaked);
  }
});

test("an empty final reply cannot classify earlier commentary as completion", async () => {
  const requestJev = jev(verdict());
  const run = harness({ requestJev });
  await run.core.start("s");
  await run.core.finish([
    user("Fix the build", 1),
    assistant("I need access before proceeding.", 2, "toolUse"),
    assistant([], 3),
  ]);
  await run.fire();
  assert.equal(requestJev.calls.length, 0);
  assert.equal(status(run.tmux), "done");
  assert.equal(run.diagnostics[0].event, "failure");
});

test("transcript bounds keep the start and end of long messages", async () => {
  const requestJev = jev(verdict({ outcome: "clean_completion" }));
  const run = harness({ requestJev });
  await run.core.start("s");
  await run.core.finish([
    user(`BEGIN-REQUEST ${"r".repeat(6000)} END-REQUEST`, 1),
    assistant(`BEGIN-REPLY ${"a".repeat(20000)} END-REPLY`, 2),
  ]);
  await run.fire();
  const { state } = requestJev.calls[0];
  assert.ok(state.latest_user_request.length <= 2400);
  assert.ok(state.final_assistant_message.length <= 3200);
  assert.ok(state.latest_user_request.startsWith("BEGIN-REQUEST") && state.latest_user_request.endsWith("END-REQUEST"));
  assert.ok(state.final_assistant_message.startsWith("BEGIN-REPLY") && state.final_assistant_message.endsWith("END-REPLY"));
});

test("in-flight classification is ignored after newer activity, reset or disposal", async () => {
  const invalidations = {
    start: (core) => core.start("s"),
    reset: (core) => core.reset("other", false),
    dispose: (core) => core.dispose(),
  };
  const expected = { start: "working", reset: "idle", dispose: undefined };
  for (const [name, invalidate] of Object.entries(invalidations)) {
    const reply = deferred();
    const run = harness({ requestJev: jev(() => reply.promise) });
    await run.core.start("s");
    await run.core.finish(turn());
    const running = run.fire();
    await settle();
    await invalidate(run.core);
    reply.resolve(verdict());
    await running;
    assert.equal(status(run.tmux), expected[name], name);
    assert.equal(run.bells.length, 1, `${name}: only the completion rang`);
  }

  const first = deferred();
  const second = deferred();
  const replies = [first, second];
  const run = harness({ requestJev: jev(() => replies.shift().promise) });
  await run.core.start("s");
  await run.core.finish(turn("First"));
  const firstRun = run.fire();
  await settle();
  await run.core.start("s");
  await run.core.finish(turn("Second"));
  const secondRun = run.fire();
  await settle();
  second.resolve(verdict({ outcome: "clean_completion" }));
  await secondRun;
  first.resolve(verdict({ outcome: "blocked_failure" }));
  await firstRun;
  assert.equal(status(run.tmux), "done");
});

test("activity before the debounce fires cancels classification entirely", async () => {
  const requestJev = jev(verdict());
  const run = harness({ requestJev });
  await run.core.start("s");
  await run.core.finish(turn());
  assert.equal(run.pending(), 1);
  await run.core.wait("ask:1");
  assert.equal(run.pending(), 0);
  await run.fire();
  assert.equal(requestJev.calls.length, 0);
  assert.equal(status(run.tmux), "waiting");
});

test("split panes aggregate by priority and a closing pane leaves the others' state", async () => {
  const tmux = createTmux(["%1", "%2"]);
  const clock = { ms: 1_000_000 };
  const off = { OMP_JEV_ATTENTION_MODE: "off" };
  const a = harness({ tmux, pane: "%1", clock, env: off });
  const b = harness({ tmux, pane: "%2", clock, env: off });

  await a.core.start("s1");
  clock.ms += 20_000;
  await b.core.start("s2");
  assert.equal(status(tmux), "working");
  assert.equal(tmux.window["@opencode_started_at"], "1000");

  clock.ms += 10_000;
  await b.core.finish(turn());
  assert.equal(status(tmux), "done");
  assert.equal(tmux.window["@opencode_duration"], "00:10");
  assert.equal(paneStatus(tmux, "%1"), "working");

  await a.core.wait("ask:1");
  assert.equal(status(tmux), "waiting");
  assert.equal(tmux.window["@opencode_started_at"], "1000");
  await a.core.resume("ask:1");
  await a.core.finish([user("Go", 1), assistant("Provider failed", 2, "error")]);
  assert.equal(status(tmux), "error");

  await a.core.start("s1");
  clock.ms += 5_000;
  // Closing pane 2 must not erase pane 1's active work.
  await b.core.dispose();
  assert.equal(paneStatus(tmux, "%2"), undefined);
  assert.equal(tmux.panes.get("%2")["@opencode_pane_started_at"], undefined);
  assert.equal(status(tmux), "working");
  assert.equal(tmux.window["@opencode_started_at"], "1030");
  assert.equal(paneStatus(tmux, "%1"), "working");

  await a.core.dispose();
  assert.deepEqual(tmux.window, {});
  assert.deepEqual(tmux.panes.get("%1"), {});
});

test("disposing a finished pane keeps another pane's completion", async () => {
  const tmux = createTmux(["%1", "%2"]);
  const off = { OMP_JEV_ATTENTION_MODE: "off" };
  const a = harness({ tmux, pane: "%1", env: off });
  const b = harness({ tmux, pane: "%2", env: off });
  await a.core.start("s1");
  await a.core.finish(turn());
  await b.core.start("s2");
  await b.core.dispose();
  assert.equal(status(tmux), "done");
  assert.ok(tmux.window["@opencode_duration"]);
});

test("aggregation picks the highest priority, earliest start and newest completion", () => {
  assert.deepEqual(aggregatePaneStates([]), { state: null, startedAt: null, duration: null });
  assert.deepEqual(aggregatePaneStates([{ state: null }, { state: "bogus" }]), { state: null, startedAt: null, duration: null });
  assert.deepEqual(aggregatePaneStates([{ state: "idle" }, { state: "idle" }]), { state: "idle", startedAt: null, duration: null });
  assert.deepEqual(aggregatePaneStates([
    { state: "working", startedAt: "200" },
    { state: "waiting", startedAt: "150" },
    { state: "working", startedAt: "100" },
    { state: "done", duration: "00:09", updatedAt: "9" },
  ]), { state: "waiting", startedAt: 100, duration: null });
  assert.deepEqual(aggregatePaneStates([
    { state: "done", duration: "00:09", updatedAt: "9" },
    { state: "done", duration: "00:42", updatedAt: "42" },
    { state: "working", startedAt: "1" },
  ]), { state: "done", startedAt: null, duration: "00:42" });
  assert.equal(aggregatePaneStates([{ state: "waiting" }, { state: "error" }, { state: "done" }]).state, "error");
});

test("a seen completion stays seen: tmux acknowledgement and visible windows clear done panes", async () => {
  const tmux = createTmux(["%1", "%2"]);
  const off = { OMP_JEV_ATTENTION_MODE: "off" };
  const a = harness({ tmux, pane: "%1", env: off });
  const b = harness({ tmux, pane: "%2", env: off });

  await b.core.start("s2");
  await b.core.finish(turn());
  assert.equal(paneStatus(tmux, "%2"), "done");
  // The tmux focus hook marks the window idle once the user has seen it.
  tmux.window["@opencode_status"] = "idle";
  await a.core.start("s1");
  assert.equal(paneStatus(tmux, "%2"), "idle");
  assert.equal(status(tmux), "working");

  await b.core.start("s2");
  await b.core.wait("approval:1");
  tmux.window["@opencode_status"] = "idle";
  await a.core.finish(turn());
  assert.equal(paneStatus(tmux, "%2"), "waiting");
  assert.equal(status(tmux), "waiting");

  // With a client watching the window, completions are acknowledged immediately.
  const watched = createTmux(["%1", "%2"], 1);
  const c = harness({ tmux: watched, pane: "%1", env: off });
  const d = harness({ tmux: watched, pane: "%2", env: off });
  await c.core.start("s1");
  await d.core.start("s2");
  await d.core.finish(turn());
  assert.equal(paneStatus(watched, "%2"), "idle");
  assert.equal(status(watched), "working");
  await c.core.finish([user("Go", 1), assistant("Provider failed", 2, "error")]);
  assert.equal(status(watched), "error");
  assert.equal(c.bells.length + d.bells.length, 0);
});

test("bells ring for completions and attention in the background, once per cooldown", async () => {
  const off = { OMP_JEV_ATTENTION_MODE: "off", OMP_JEV_ATTENTION_COOLDOWN_MS: "2000" };
  const run = harness({ env: off });
  await run.core.start("s");
  assert.deepEqual(run.bells, []);
  await run.core.finish(turn());
  assert.deepEqual(run.bells, [7]);
  run.clock.ms += 1_000;
  await run.core.start("s");
  await run.core.finish(turn());
  assert.equal(run.bells.length, 1);
  run.clock.ms += 2_000;
  await run.core.start("s");
  await run.core.wait("approval:1");
  assert.equal(run.bells.length, 2);
  await run.core.resume("approval:1");
  await run.core.finish([user("Go", 1), assistant("Stopped", 2, "aborted")]);
  assert.equal(run.bells.length, 2);
  run.clock.ms += 2_000;
  await run.core.start("s");
  await run.core.finish([user("Go", 1), assistant("Provider failed", 2, "error")]);
  assert.equal(run.bells.length, 3);

  const watched = harness({ tmux: createTmux(["%1"], 1), env: off });
  await watched.core.start("s");
  await watched.core.wait("ask:1");
  await watched.core.resume("ask:1");
  await watched.core.finish(turn());
  assert.deepEqual(watched.bells, []);

  const attention = harness({ requestJev: jev(verdict()) });
  await attention.core.start("s");
  await attention.core.finish(turn());
  await attention.fire();
  assert.equal(status(attention.tmux), "waiting");
  assert.equal(attention.bells.length, 2);

  const quiet = harness({ env: { OMP_JEV_ATTENTION_COOLDOWN_MS: "2000" }, requestJev: jev(verdict()) });
  await quiet.core.start("s");
  await quiet.core.finish(turn());
  await quiet.fire();
  assert.equal(status(quiet.tmux), "waiting");
  assert.equal(quiet.bells.length, 1);
});

test("a broken pane tty falls back to the terminal bell", async () => {
  let attempts = 0;
  const run = harness({
    env: { OMP_JEV_ATTENTION_MODE: "off" },
    writeSync: () => { attempts += 1; throw new Error("tty gone"); },
  });
  await run.core.start("s");
  await run.core.finish(turn());
  await run.core.start("s");
  await run.core.finish(turn());
  assert.deepEqual(run.bells, ["stdout", "stdout"]);
  assert.equal(attempts, 1);
  assert.deepEqual(run.closed, [7]);
});

test("disposal and process exit clear only this pane, stop writing and bells, and release the tty", async () => {
  const tmux = createTmux(["%1", "%2"]);
  const off = { OMP_JEV_ATTENTION_MODE: "off" };
  const other = harness({ tmux, pane: "%2", env: off });
  await other.core.start("other");

  const run = harness({ tmux, pane: "%1", env: off });
  await run.core.start("s");
  await run.core.wait("ask:1");
  assert.equal(run.exits.size, 1);
  const bellsBeforeDispose = run.bells.length;
  await run.core.dispose();
  await run.core.dispose();
  assert.equal(run.exits.size, 0);
  assert.deepEqual(run.closed, [7]);
  assert.deepEqual(tmux.panes.get("%1"), {});
  assert.equal(status(tmux), "working");
  assert.equal(paneStatus(tmux, "%2"), "working");

  const before = structuredClone({ window: tmux.window, panes: [...tmux.panes] });
  await run.core.start("s");
  await run.core.wait("ask:2");
  await run.core.finish(turn());
  await run.core.reset("s", true);
  assert.deepEqual({ window: tmux.window, panes: [...tmux.panes] }, before);
  assert.equal(run.bells.length, bellsBeforeDispose);

  // process exit: same cleanup, synchronously, without an explicit dispose
  const exiting = harness({ tmux, pane: "%1", env: off });
  await exiting.core.start("s");
  assert.equal(paneStatus(tmux, "%1"), "working");
  const [onExit] = exiting.exits;
  onExit();
  assert.deepEqual(tmux.panes.get("%1"), {});
  assert.equal(paneStatus(tmux, "%2"), "working");
  assert.deepEqual(exiting.closed, [7]);
  await exiting.core.start("s");
  assert.deepEqual(tmux.panes.get("%1"), {});
});

test("without tmux the controller is inert", async () => {
  for (const env of [{ TMUX: "", TMUX_PANE: "%1" }, { TMUX: "/tmp/tmux", TMUX_PANE: "" }, { TMUX: "/tmp/tmux", TMUX_PANE: "bad" }]) {
    let spawned = 0;
    const requestJev = jev(verdict());
    const core = createTmuxStatus({
      env: { HOME: "/nonexistent-home", ...env },
      spawnSync: () => { spawned += 1; return { status: 0, stdout: "" }; },
      onExit: () => { spawned += 1; },
      requestJev,
    });
    await core.reset("s", true);
    await core.start("s");
    await core.wait("ask:1");
    await core.resume("ask:1");
    await core.finish(turn());
    await core.dispose();
    assert.equal(spawned, 0);
    assert.equal(requestJev.calls.length, 0);
  }
});

function secretsFixture() {
  const dir = mkdtempSync(join(tmpdir(), "omp-status-secrets-"));
  const file = (name, key) => {
    const path = join(dir, name);
    writeFileSync(path, `TYPESAFE_API_KEY=${key}\n`);
    return path;
  };
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("Jev credentials and model come from omp settings, never OpenCode's", async () => {
  const fixture = secretsFixture();
  try {
    const home = join(fixture.dir, "home");
    mkdirSync(join(home, ".config", "home-manager"), { recursive: true });
    writeFileSync(join(home, ".config", "home-manager", "secrets.env"), "TYPESAFE_API_KEY=home-key\n");
    const opencode = {
      OPENCODE_SECRETS_FILE: fixture.file("opencode.env", "opencode-key"),
      OPENCODE_JEV_MODEL: "opencode-model",
      OPENCODE_JEV_ATTENTION_MODEL: "opencode-attention-model",
    };
    const cases = [
      ["explicit omp secrets file", { OMP_JEV_ATTENTION_SECRETS_FILE: fixture.file("omp.env", "file-key"), HOME: home }, "file-key", "jev-latest"],
      ["home-manager secrets fallback", { HOME: home }, "home-key", "jev-latest"],
      ["environment key and model", { TYPESAFE_API_KEY: "env-key", OMP_JEV_ATTENTION_MODEL: "custom-model", HOME: home }, "env-key", "custom-model"],
    ];
    for (const [label, env, key, model] of cases) {
      const calls = [];
      const fetch = async (url, init) => {
        calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        return { ok: true, status: 200, headers: new Headers(), json: async () => verdict() };
      };
      const run = harness({ env: { ...opencode, ...env }, fetch, requestJev: undefined });
      await run.core.start("s");
      await run.core.finish(turn());
      await run.fire();
      assert.equal(calls.length, 1, label);
      assert.equal(calls[0].headers.Authorization, `Bearer ${key}`, label);
      assert.equal(calls[0].body.model, model, label);
      assert.equal(status(run.tmux), "waiting", label);
    }

    let fetched = 0;
    const missing = harness({
      env: { ...opencode, HOME: join(fixture.dir, "empty-home") },
      fetch: async () => { fetched += 1; throw new Error("must not be called"); },
      requestJev: undefined,
    });
    await missing.core.start("s");
    await missing.core.finish(turn());
    await missing.fire();
    assert.equal(fetched, 0);
    assert.equal(status(missing.tmux), "done");
    assert.equal(missing.diagnostics[0].event, "failure");
  } finally {
    fixture.cleanup();
  }
});

test("decision log lives under the omp state directory and holds no transcript or credential", async () => {
  const state = mkdtempSync(join(tmpdir(), "omp-status-state-"));
  try {
    const key = "sk-live-secret-key";
    const responses = [verdict({ outcome: "clean_completion" }), new Error(`HTTP failed for Bearer ${key} while sending ${key}`)];
    const run = harness({
      env: { XDG_STATE_HOME: state, TYPESAFE_API_KEY: key },
      appendDiagnostic: undefined,
      requestJev: async () => {
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    });
    for (const text of ["TRANSCRIPT-MARKER one", "TRANSCRIPT-MARKER two"]) {
      await run.core.start("s");
      await run.core.finish([user("TRANSCRIPT-MARKER request", 1), assistant(text, 2)]);
      await run.fire();
    }
    const path = join(state, "omp", "jev-attention", "decisions.jsonl");
    for (let i = 0; i < 100 && !(existsSync(path) && readFileSync(path, "utf8").trim().split("\n").length >= 2); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const text = readFileSync(path, "utf8");
    const records = text.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.event), ["decision", "failure"]);
    assert.ok(!text.includes("TRANSCRIPT-MARKER"));
    assert.ok(!text.includes(key));
    assert.ok(!existsSync(join(state, "opencode")));
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("switching between busy sessions starts a fresh prompt timer", async () => {
  const { core, tmux, clock } = harness({ env: { OMP_JEV_ATTENTION_MODE: "off" } });
  await core.reset("first", true);
  clock.ms += 30_000;
  await core.reset("second", true);
  assert.equal(status(tmux), "working");
  assert.equal(tmux.window["@opencode_started_at"], "1030");
  clock.ms += 5_000;
  await core.finish(turn());
  assert.equal(tmux.window["@opencode_duration"], "00:05");
  await core.reset("second");
  assert.equal(status(tmux), "idle");
  assert.equal(tmux.window["@opencode_started_at"], undefined);
});

test("continuations keep one prompt timer; a start after a settled state begins a new one", async () => {
  const run = harness({ env: { OMP_JEV_ATTENTION_MODE: "off" } });
  const { core, clock, tmux } = run;
  await core.start("s");
  clock.ms += 40_000;
  // Automatic continuation or retry of the same request.
  await core.start("s");
  assert.equal(tmux.window["@opencode_started_at"], "1000");
  await core.wait("approval:1");
  clock.ms += 5_000;
  await core.start("s");
  assert.equal(status(tmux), "waiting");
  assert.equal(tmux.window["@opencode_started_at"], "1000");
  await core.resume("approval:1");
  clock.ms += 15_000;
  await core.finish(turn());
  assert.equal(tmux.window["@opencode_duration"], "01:00");

  clock.ms += 5_000;
  await core.start("s");
  assert.equal(tmux.window["@opencode_started_at"], "1065");
  await core.finish([user("Go", 1), assistant("Stopped", 2, "aborted")]);
  clock.ms += 5_000;
  await core.start("s");
  assert.equal(tmux.window["@opencode_started_at"], "1070");
});
