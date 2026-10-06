import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tmuxTitle, { completedTurn } from "./tmux-title.ts";
import { createTmuxTitleNamer } from "./tmux-title-core.js";

const user = (text, timestamp = 1) => ({ role: "user", content: text, timestamp });
const assistant = (text, timestamp = 2, stopReason = "stop") => ({
  role: "assistant", content: [{ type: "text", text }], timestamp, stopReason,
});
const answer = (choice, probability = 1) => ({ answers: {
  name: { type: "choice", choice, confidence: 1 },
  needs_update: { type: "noul", noul: probability },
} });

function windowNamer(requestJev, env = {}) {
  const window = { name: "repo:pull-main" };
  const namer = createTmuxTitleNamer({
    env: { TMUX: "smoke", TMUX_PANE: "%1", ...env }, requestJev,
    spawnSync(command, args) {
      if (command === "git") return { status: 0, stdout: "/repo/.git" };
      if (args[0] === "display-message") return { status: 0, stdout: window.name };
      if (args[0] === "rename-window") { window.name = args.at(-1); return { status: 0 }; }
      throw new Error(`Unexpected command: ${command}`);
    },
  });
  return { window, namer };
}

const turn = { sessionID: "s", directory: "/repo", request: "Fix tmux titles", response: "Fixed tmux titles." };

test("completed turns use the latest user and final assistant, not tool output or thinking", () => {
  const messages = [user("Pull main"), assistant("Pulled main"), user("Fix tmux titles", 3),
    assistant("Calling tools", 4, "toolUse"), { role: "toolResult", content: [], timestamp: 5 },
    { ...assistant("Fixed tmux titles", 6), content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Fixed tmux titles" }] }];
  assert.deepEqual(completedTurn(messages), {
    key: JSON.stringify([3, 6, "Fix tmux titles", "Fixed tmux titles"]),
    request: "Fix tmux titles", response: "Fixed tmux titles",
  });
  assert.equal(completedTurn([...messages, user("Next task", 7)]), undefined);
  for (const reason of ["toolUse", "error", "aborted"]) {
    assert.equal(completedTurn([user("Fix tmux titles"), assistant("Incomplete", 2, reason)]), undefined);
  }
});

test("a misleading window is renamed, but adequate titles and judge failures are retained", async () => {
  for (const [result, expected] of [[answer("fix-tmux-titles", 1), "repo:fix-tmux-titles"],
    [answer("fix-tmux-titles", 0.79), "repo:pull-main"],
    [answer("not-a-candidate", 1), "repo:pull-main"], [new Error("offline"), "repo:pull-main"]]) {
    const { window, namer } = windowNamer(async () => { if (result instanceof Error) throw result; return result; });
    await namer.review(turn);
    assert.equal(window.name, expected);
  }
});

test("late results cannot rename a replaced session; external window writes do not arbitrate", async () => {
  let release;
  let active = true;
  const { window, namer } = windowNamer(() => new Promise(resolve => { release = resolve; }));
  const stale = namer.review({ ...turn, shouldApply: () => active });
  active = false;
  release(answer("fix-tmux-titles"));
  await stale;
  assert.equal(window.name, "repo:pull-main");
  active = true;
  const latest = namer.review({ ...turn, shouldApply: () => active });
  window.name = "repo:another-task";
  release(answer("fix-tmux-titles"));
  await latest;
  assert.equal(window.name, "repo:fix-tmux-titles");
});

test("returning to an already named session reapplies its name", async () => {
  const { window, namer } = windowNamer(async () => answer("fix-tmux-titles"));
  const input = { sessionID: "s", title: "Fix tmux titles", directory: "/repo" };
  await namer.rename(input);
  window.name = "repo:other-session";
  await namer.rename(input);
  assert.equal(window.name, "repo:fix-tmux-titles");
});

async function withAdapter(run, requestJev) {
  const saved = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
  process.env.TMUX = "smoke";
  process.env.TMUX_PANE = "%1";
  const handlers = new Map();
  const timers = new Set();
  const state = { id: "a", title: "Fix tmux titles", transcript: [] };
  const { window, namer } = windowNamer(requestJev ?? (async ({ questions }) => answer(Object.keys(questions.name.criteria)[0])));
  const ctx = {
    cwd: "/repo", mode: "tui", agent: { kind: "main" }, isIdle: () => true,
    sessionManager: {
      getSessionId: () => state.id, getSessionName: () => state.title,
      getBranch: () => state.transcript.map(message => ({ type: "message", message })),
    },
    setInterval(callback) { timers.add(callback); return callback; },
    clearTimer(callback) { timers.delete(callback); },
    ui: { notify(message) { throw new Error(message); } },
  };
  const emit = (name, event = {}, context = ctx) => handlers.get(name)?.(event, context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    tmuxTitle({ on(name, callback) { handlers.set(name, callback); } }, { namer });
    await run({ window, state, ctx, emit, settle, timers });
  } finally {
    await emit("session_shutdown");
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}

test("session switches invalidate pending names and subagents cannot take over the window", async () => {
  let release;
  await withAdapter(async ({ window, state, ctx, emit, settle, timers }) => {
    emit("session_start");
    await settle();
    state.id = "b";
    state.title = "Fix window labels";
    emit("session_switch");
    emit("session_start", {}, { ...ctx, agent: { kind: "sub" } });
    release(answer("fix-tmux-titles"));
    await settle();
    assert.equal(window.name, "repo:pull-main");
    release(answer("fix-window-labels"));
    await settle();
    assert.equal(window.name, "repo:fix-window-labels");
    state.title = "Fix keyboard shortcuts";
    for (const tick of timers) tick();
    await settle();
    release(answer("fix-keyboard-shortcuts"));
    await settle();
    assert.equal(window.name, "repo:fix-keyboard-shortcuts");
  }, () => new Promise(resolve => { release = resolve; }));
});

test("automatic continuations keep the title until the final completed turn", async () => {
  await withAdapter(async ({ window, state, emit, settle }) => {
    emit("session_start");
    await settle();
    assert.equal(window.name, "repo:fix-tmux-titles");
    state.transcript = [user("Fix window labels"), assistant("Fixed window labels")];
    emit("agent_start");
    emit("agent_end", { messages: state.transcript, willContinue: true });
    await settle();
    assert.equal(window.name, "repo:fix-tmux-titles");
    emit("agent_end", { messages: state.transcript });
    await settle();
    assert.equal(window.name, "repo:fix-window-labels");
  });
});

test("only omp settings can change the title-review threshold", async () => {
  const { window: ignored, namer: original } = windowNamer(async () => answer("fix-tmux-titles", 0.7),
    { OPENCODE_TMUX_TITLE_UPDATE_MIN: "0.6" });
  await original.review(turn);
  assert.equal(ignored.name, "repo:pull-main");
  const { window, namer } = windowNamer(async () => answer("fix-tmux-titles", 0.7),
    { OMP_TMUX_TITLE_UPDATE_MIN: "0.6" });
  await namer.review(turn);
  assert.equal(window.name, "repo:fix-tmux-titles");
});

test("omp secret-file selection cannot be redirected by another app", async t => {
  const scratch = mkdtempSync(join(tmpdir(), "omp-title-auth-"));
  const own = join(scratch, "omp.env");
  const other = join(scratch, "other.env");
  writeFileSync(own, "TYPESAFE_API_KEY=omp-title-fixture\n");
  writeFileSync(other, "TYPESAFE_API_KEY=other-title-fixture\n");
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const authorized = options.headers.Authorization === "Bearer omp-title-fixture";
    return new Response(JSON.stringify(answer("fix-tmux-titles")),
      { status: authorized ? 200 : 401 });
  });
  try {
    const { window, namer } = windowNamer(undefined, {
      OMP_TMUX_TITLE_SECRETS_FILE: own, OPENCODE_SECRETS_FILE: other,
    });
    await namer.review(turn);
    assert.equal(window.name, "repo:fix-tmux-titles");
  } finally {
    rmSync(scratch, { recursive: true });
  }
});
