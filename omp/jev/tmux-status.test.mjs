import assert from "node:assert/strict";
import test from "node:test";
import tmuxStatus from "./tmux-status.ts";
import { createTmuxStatus } from "./tmux-status-core.js";

const PANE = "%1";
const user = (text, timestamp = 1) => ({ role: "user", content: text, timestamp });
const assistant = (text, timestamp = 2, stopReason = "stop") => ({
  role: "assistant",
  content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text }],
  timestamp,
  stopReason,
});
const jevAnswer = (choice, { needs = 1, completed = 0, confidence = 1 } = {}) => ({
  model: "jev-test",
  usage: {},
  answers: {
    needs_attention: { type: "noul", noul: needs },
    completed_cleanly: { type: "noul", noul: completed },
    outcome: { type: "choice", choice, confidence },
  },
});

// Minimal tmux server model: pane-scoped and window-scoped user options for one window.
// It answers the same list-panes/display-message/set-option commands the controller issues, so
// assertions read what tmux.nix would read rather than which commands the controller sent.
function fakeTmux(panes = [PANE]) {
  const paneOptions = new Map(panes.map(id => [id, {}]));
  const windowOptions = {};
  let activeClients = 0;
  const resolve = (format, id) => format.replace(/#\{([^}]*)\}/g, (_match, name) => {
    if (name === "pane_id") return id ?? PANE;
    if (name === "pane_tty") return "";
    if (name === "window_active_clients") return String(activeClients);
    return paneOptions.get(id)?.[name] ?? windowOptions[name] ?? "";
  });
  const setOptions = args => {
    let command = [];
    const commands = [];
    for (const arg of args) {
      if (arg === ";") { commands.push(command); command = []; } else command.push(arg);
    }
    commands.push(command);
    for (const [name, scope, ...rest] of commands) {
      if (name !== "set-option") continue;
      const unset = rest[0] === "-u";
      const flags = unset ? rest.slice(1) : rest;
      const [, target, option, value] = flags;
      const store = scope === "-w" ? windowOptions : paneOptions.get(target) ?? paneOptions.set(target, {}).get(target);
      if (unset) delete store[option]; else store[option] = value;
    }
  };
  const spawnSync = (_command, args) => {
    const [name] = args;
    if (name === "list-panes") {
      return { status: 0, stdout: [...paneOptions.keys()].map(id => resolve(args[args.indexOf("-F") + 1], id)).join("\n") };
    }
    if (name === "display-message") return { status: 0, stdout: resolve(args.at(-1), PANE) };
    if (name === "set-option") setOptions(args);
    return { status: 0, stdout: "" };
  };
  return {
    spawnSync,
    window: windowOptions,
    pane: id => paneOptions.get(id),
    setVisible: visible => { activeClients = visible ? 1 : 0; },
    status: () => windowOptions["@opencode_status"] ?? null,
  };
}

async function until(predicate, message) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail(message ?? "condition was never reached");
}
const quiet = () => new Promise(resolve => setTimeout(resolve, 25));

async function withAdapter(run, { panes, answers, envOverrides = {}, includeTmuxEnv = true } = {}) {
  const tmux = fakeTmux(panes);
  const bells = [];
  const jevCalls = [];
  const notices = [];
  const env = {
    HOME: "/nonexistent-home",
    XDG_STATE_HOME: "/nonexistent-state",
    OMP_JEV_ATTENTION_MODE: "on",
    OMP_JEV_ATTENTION_DEBOUNCE_MS: "0",
    OMP_JEV_ATTENTION_COOLDOWN_MS: "0",
    ...(includeTmuxEnv ? { TMUX: "/tmp/tmux-test/default,1,0", TMUX_PANE: PANE } : {}),
    ...envOverrides,
  };
  let clock = 1_000_000;
  const createdControllers = [];
  const overrides = {
    env,
    spawnSync: tmux.spawnSync,
    openSync() { throw new Error("no tty in tests"); },
    stdoutWrite: value => bells.push(value),
    now: () => clock,
    onExit() {},
    offExit() {},
    appendDiagnostic: async () => {},
    requestJev: async request => {
      jevCalls.push(request);
      return answers ? answers(request, jevCalls.length) : jevAnswer("clean_completion");
    },
  };
  const handlers = new Map();
  const state = { id: "session-a", idle: true };
  const contextFor = (kind = "main", mode = "tui") => ({
    cwd: "/repo",
    mode,
    agent: { kind },
    isIdle: () => state.idle,
    sessionManager: { getSessionId: () => state.id },
    ui: { notify: message => notices.push(message) },
  });
  const ctx = contextFor();
  const emit = (name, event = {}, context = ctx) => handlers.get(name)?.(event, context);
  tmuxStatus(
    { on(name, callback) { handlers.set(name, callback); } },
    {
      env,
      createStatus: () => {
        const controller = createTmuxStatus(overrides);
        createdControllers.push(controller);
        return controller;
      },
    },
  );
  try {
    await run({
      tmux, bells, jevCalls, notices, state, ctx, emit, contextFor, createdControllers,
      tick: ms => { clock += ms; },
    });
  } finally {
    await emit("session_shutdown");
    await Promise.all(createdControllers.map(controller => controller.dispose()));
  }
  assert.deepEqual(notices, [], "adapter must not surface tmux failures in a healthy run");
}

const turn = (...messages) => messages;

test("main TUI prompt maps to working with a timer, then to a timed done", async () => {
  await withAdapter(async ({ tmux, emit, tick, jevCalls }) => {
    await emit("session_start");
    assert.equal(tmux.status(), "idle");
    await emit("agent_start");
    assert.equal(tmux.status(), "working");
    assert.equal(tmux.window["@opencode_started_at"], "1000");
    tick(65_000);
    await emit("agent_end", { messages: turn(user("Ship it"), assistant("Shipped.")) });
    assert.equal(tmux.status(), "done");
    assert.equal(tmux.window["@opencode_duration"], "01:05");
    assert.equal(tmux.window["@opencode_started_at"], undefined);
    await until(() => jevCalls.length === 1);
    await quiet();
    assert.equal(tmux.status(), "done");
  });
});

test("session start while the agent is busy reports working immediately", async () => {
  await withAdapter(async ({ tmux, state, emit }) => {
    state.idle = false;
    await emit("session_start");
    assert.equal(tmux.status(), "working");
    assert.ok(tmux.window["@opencode_started_at"]);
  });
});

test("subagent and non-TUI contexts cannot create, clear, or retime the main status", async () => {
  await withAdapter(async ({ tmux, state, emit, contextFor, tick, jevCalls }) => {
    await emit("session_start");
    await emit("agent_start");
    const startedAt = tmux.window["@opencode_started_at"];
    tick(30_000);
    for (const foreign of [contextFor("sub", "tui"), contextFor("main", "rpc"), contextFor("sub", "rpc")]) {
      state.id = "foreign";
      state.idle = true;
      await emit("session_start", {}, foreign);
      await emit("session_switch", {}, foreign);
      await emit("session_branch", {}, foreign);
      await emit("session_tree", {}, foreign);
      await emit("agent_start", {}, foreign);
      await emit("tool_execution_start", { toolName: "ask", toolCallId: "x" }, foreign);
      await emit("tool_approval_requested", { toolCallId: "y" }, foreign);
      await emit("tool_execution_end", { toolName: "ask", toolCallId: "x" }, foreign);
      await emit("tool_approval_resolved", { toolCallId: "y" }, foreign);
      await emit("agent_end", { messages: turn(user("sub"), assistant("sub done")) }, foreign);
      await emit("session_shutdown", {}, foreign);
      assert.equal(tmux.status(), "working");
      assert.equal(tmux.window["@opencode_started_at"], startedAt);
      assert.equal(tmux.window["@opencode_duration"], undefined);
    }
    await quiet();
    assert.equal(jevCalls.length, 0);
    // The foreign shutdowns did not disable the real owner.
    state.id = "session-a";
    await emit("agent_end", { messages: turn(user("main"), assistant("main done")) });
    assert.equal(tmux.status(), "done");
    assert.equal(tmux.window["@opencode_duration"], "00:30");
  });
});

test("subagent-only sessions never touch tmux", async () => {
  await withAdapter(async ({ tmux, emit, contextFor, createdControllers }) => {
    const sub = contextFor("sub", "tui");
    await emit("session_start", {}, sub);
    await emit("agent_start", {}, sub);
    await emit("agent_end", { messages: turn(user("a"), assistant("b")) }, sub);
    assert.equal(createdControllers.length, 0);
    assert.equal(tmux.status(), null);
  });
});

test("handlers are inert without a valid tmux pane environment", async () => {
  for (const envOverrides of [{ TMUX: "", TMUX_PANE: "" }, { TMUX_PANE: "not-a-pane" }, { TMUX: "" }]) {
    await withAdapter(async ({ tmux, emit, createdControllers }) => {
      await emit("session_start");
      await emit("agent_start");
      await emit("agent_end", { messages: turn(user("a"), assistant("b")) });
      assert.equal(createdControllers.length, 0);
      assert.equal(tmux.status(), null);
    }, { envOverrides });
  }
  await withAdapter(async ({ emit, createdControllers }) => {
    await emit("session_start");
    assert.equal(createdControllers.length, 0);
  }, { includeTmuxEnv: false });
});

test("automatic continuations never complete or classify; only the final settle does", async () => {
  await withAdapter(async ({ tmux, emit, jevCalls }) => {
    await emit("session_start");
    await emit("agent_start");
    const transcript = turn(user("Fix it"), assistant("Retrying after a hiccup."));
    await emit("agent_end", { messages: transcript, willContinue: true });
    await quiet();
    assert.equal(tmux.status(), "working");
    assert.equal(jevCalls.length, 0);
    await emit("agent_start");
    await emit("agent_end", { messages: turn(user("Fix it"), assistant("Fixed.")) });
    assert.equal(tmux.status(), "done");
    await until(() => jevCalls.length === 1);
  });
});

test("classification is asynchronous: events settle before Jev answers, and its verdict applies later", async () => {
  let release;
  await withAdapter(async ({ tmux, bells, emit, jevCalls }) => {
    await emit("session_start");
    await emit("agent_start");
    await emit("agent_end", { messages: turn(user("Deploy?"), assistant("Which environment should I deploy to?")) });
    assert.equal(tmux.status(), "done");
    await until(() => jevCalls.length === 1);
    // The request is still unanswered, yet the settle event already returned with done applied.
    assert.equal(tmux.status(), "done");
    const bellsBefore = bells.length;
    release(jevAnswer("awaiting_user_input"));
    await until(() => tmux.status() === "waiting");
    assert.ok(bells.length > bellsBefore, "waiting verdict rings the bell");
  }, { answers: () => new Promise(resolve => { release = resolve; }) });
});

test("native terminal errors become error without classification; aborts return to idle", async () => {
  await withAdapter(async ({ tmux, emit, jevCalls }) => {
    await emit("session_start");
    await emit("agent_start");
    await emit("agent_end", { messages: turn(user("Run"), assistant("Provider failed.", 2, "error")) });
    assert.equal(tmux.status(), "error");
    await emit("agent_start");
    assert.equal(tmux.status(), "working");
    await emit("agent_end", { messages: turn(user("Run"), assistant("Stopped.", 3, "aborted")) });
    assert.notEqual(tmux.status(), "error");
    assert.notEqual(tmux.status(), "done");
    assert.equal(tmux.status(), "idle");
    await quiet();
    assert.equal(jevCalls.length, 0);
  });
});

test("ordinary tool failures and earlier-request errors do not make a clean final turn an error", async () => {
  await withAdapter(async ({ tmux, emit }) => {
    await emit("session_start");
    await emit("agent_start");
    await emit("tool_execution_start", { toolName: "bash", toolCallId: "t1" });
    await emit("tool_execution_end", { toolName: "bash", toolCallId: "t1", isError: true });
    assert.equal(tmux.status(), "working");
    await emit("agent_end", {
      messages: turn(
        user("First", 1), assistant("boom", 2, "error"),
        user("Second", 3), assistant("Recovered and finished.", 4, "stop"),
      ),
    });
    assert.equal(tmux.status(), "done");
  });
});

test("overlapping ask dialogs and approvals keep waiting until the last one resolves", async () => {
  await withAdapter(async ({ tmux, emit }) => {
    await emit("session_start");
    await emit("agent_start");
    await emit("tool_execution_start", { toolName: "ask", toolCallId: "1" });
    assert.equal(tmux.status(), "waiting");
    await emit("tool_approval_requested", { toolCallId: "1" });
    await emit("tool_execution_start", { toolName: "ask", toolCallId: "2" });
    await emit("tool_execution_start", { toolName: "bash", toolCallId: "3" });
    await emit("tool_execution_end", { toolName: "bash", toolCallId: "3", isError: false });
    await emit("tool_execution_end", { toolName: "ask", toolCallId: "1" });
    assert.equal(tmux.status(), "waiting");
    await emit("tool_approval_resolved", { toolCallId: "1" });
    assert.equal(tmux.status(), "waiting");
    await emit("tool_execution_end", { toolName: "ask", toolCallId: "2" });
    assert.equal(tmux.status(), "working");
  });
});

test("a waiting prompt keeps its original start time through resume", async () => {
  await withAdapter(async ({ tmux, emit, tick }) => {
    await emit("session_start");
    await emit("agent_start");
    const startedAt = tmux.window["@opencode_started_at"];
    tick(20_000);
    await emit("tool_approval_requested", { toolCallId: "a" });
    assert.equal(tmux.window["@opencode_started_at"], startedAt);
    tick(10_000);
    await emit("tool_approval_resolved", { toolCallId: "a" });
    assert.equal(tmux.window["@opencode_started_at"], startedAt);
    await emit("agent_end", { messages: turn(user("Go"), assistant("Gone.")) });
    assert.equal(tmux.window["@opencode_duration"], "00:30");
  });
});

test("a session switch resets status and invalidates classification from the old session", async () => {
  let release;
  await withAdapter(async ({ tmux, bells, emit, state, jevCalls }) => {
    await emit("session_start");
    await emit("agent_start");
    await emit("agent_end", { messages: turn(user("Old"), assistant("Which one?")) });
    assert.equal(tmux.status(), "done");
    await until(() => jevCalls.length === 1);
    state.id = "session-b";
    await emit("session_switch");
    assert.equal(tmux.status(), "idle");
    const bellsBefore = bells.length;
    release(jevAnswer("awaiting_user_input"));
    await quiet();
    assert.equal(tmux.status(), "idle");
    assert.equal(bells.length, bellsBefore);
  }, { answers: () => new Promise(resolve => { release = resolve; }) });
});

test("a new prompt invalidates classification of the previous answer", async () => {
  let release;
  await withAdapter(async ({ tmux, emit, jevCalls }) => {
    await emit("session_start");
    await emit("agent_start");
    await emit("agent_end", { messages: turn(user("One"), assistant("Which one?")) });
    await until(() => jevCalls.length === 1);
    await emit("agent_start");
    assert.equal(tmux.status(), "working");
    release(jevAnswer("blocked_failure"));
    await quiet();
    assert.equal(tmux.status(), "working");
  }, { answers: () => new Promise(resolve => { release = resolve; }) });
});

test("a switch clears outstanding waits so they cannot pin the next session", async () => {
  await withAdapter(async ({ tmux, emit, state }) => {
    await emit("session_start");
    await emit("agent_start");
    await emit("tool_approval_requested", { toolCallId: "left-open" });
    assert.equal(tmux.status(), "waiting");
    state.id = "session-b";
    await emit("session_switch");
    assert.equal(tmux.status(), "idle");
    await emit("agent_start");
    await emit("tool_approval_requested", { toolCallId: "new" });
    await emit("tool_approval_resolved", { toolCallId: "new" });
    assert.equal(tmux.status(), "working");
  });
});

test("a switch into a busy session reports working with a fresh timer", async () => {
  await withAdapter(async ({ tmux, emit, state, tick }) => {
    await emit("session_start");
    tick(5_000);
    state.id = "busy";
    state.idle = false;
    await emit("session_branch");
    assert.equal(tmux.status(), "working");
    assert.equal(tmux.window["@opencode_started_at"], "1005");
  });
});

test("shutdown clears only this pane, leaves sibling panes aggregated, and cannot be revived", async () => {
  await withAdapter(async ({ tmux, emit, createdControllers }) => {
    await emit("session_start");
    await emit("agent_start");
    // A sibling agent in the same window is still working.
    Object.assign(tmux.pane("%2"), { "@opencode_pane_status": "working", "@opencode_pane_started_at": "900" });
    await emit("session_shutdown");
    assert.equal(tmux.pane(PANE)["@opencode_pane_status"], undefined);
    assert.equal(tmux.pane("%2")["@opencode_pane_status"], "working");
    assert.equal(tmux.status(), "working");
    assert.equal(tmux.window["@opencode_started_at"], "900");
    // Late events after shutdown must not instantiate or drive anything.
    await emit("agent_end", { messages: turn(user("late"), assistant("late done")) });
    await emit("session_start");
    await emit("agent_start");
    await emit("tool_approval_requested", { toolCallId: "late" });
    assert.equal(createdControllers.length, 1);
    assert.equal(tmux.pane(PANE)["@opencode_pane_status"], undefined);
    assert.equal(tmux.status(), "working");
  }, { panes: [PANE, "%2"] });
});

test("shutdown with no sibling activity unsets the window status", async () => {
  await withAdapter(async ({ tmux, emit }) => {
    await emit("session_start");
    await emit("agent_start");
    await emit("session_shutdown");
    assert.equal(tmux.status(), null);
    assert.equal(tmux.window["@opencode_started_at"], undefined);
  });
});

test("shutdown without any prior session never creates a controller and blocks later activation", async () => {
  await withAdapter(async ({ emit, createdControllers }) => {
    await emit("session_shutdown");
    await emit("session_start");
    assert.equal(createdControllers.length, 0);
  });
});

