import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ENTRY_TYPE = "dev.tomasmota.brief";
let importSequence = 0;

async function host(t, { flag, entries = [], agentKind = "main" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "brief-extension-test-"));
  const dataHome = join(root, "data");
  const stateHome = join(root, "state");
  const activeDir = join(dataHome, "briefs", "active");
  const archiveDir = join(dataHome, "briefs", "archive");
  mkdirSync(activeDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const previousDataHome = process.env.XDG_DATA_HOME;
  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  process.env.XDG_STATE_HOME = stateHome;
  let extension;
  try {
    const moduleUrl = new URL(`./brief.ts?test=${importSequence++}`, import.meta.url);
    ({ default: extension } = await import(moduleUrl.href));
  } finally {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
  }

  const handlers = {};
  const notifications = [];
  const statuses = [];
  const appended = [];
  const warnings = [];
  let command;
  let branch = entries;
  const pi = {
    registerFlag() {},
    getFlag: () => flag,
    on(name, handler) { handlers[name] = handler; },
    registerCommand(_name, definition) { command = definition.handler; },
    appendEntry(customType, data) {
      const entry = { type: "custom", customType, data };
      branch.push(entry);
      appended.push(entry);
    },
    logger: { warn(message, data) { warnings.push({ message, data }); } },
  };
  const context = {
    agent: { kind: agentKind },
    sessionManager: { getBranch: () => branch },
    ui: {
      setStatus(name, value) { statuses.push({ name, value }); },
      notify(message, level) { notifications.push({ message, level }); },
      select: async () => undefined,
    },
  };
  extension(pi);

  return {
    activeDir,
    archiveDir,
    appended,
    command: (...args) => command(...args),
    context,
    handlers,
    loadedDir: join(stateHome, "briefs", "loaded"),
    notifications,
    setBranch(value) { branch = value; },
    statuses,
    warnings,
    writeBrief(key, notes, issue) {
      const frontMatter = issue ? `---\njira: ${issue}\n---\n\n` : "";
      writeFileSync(join(activeDir, `${key}.md`), `${frontMatter}${notes}\n`);
    },
  };
}

async function injected(host, event = "before_agent_start") {
  return host.handlers[event]({ systemPrompt: ["base prompt"] }, host.context);
}

test("startup flag injects the brief and edits appear on the next turn", async t => {
  const h = await host(t, { flag: "geoip" });
  h.writeBrief("geoip", "initial allocation notes", "CLOUD-4028");

  await h.handlers.session_start({}, h.context);
  const first = await injected(h);
  assert.deepEqual(first.systemPrompt.slice(0, -1), ["base prompt"]);
  assert.match(first.systemPrompt.at(-1), /<brief key="geoip">/);
  assert.match(first.systemPrompt.at(-1), /Jira epic CLOUD-4028/);
  assert.match(first.systemPrompt.at(-1), /not the work item for this session/);
  assert.match(first.systemPrompt.at(-1), /initial allocation notes/);
  assert.deepEqual(h.appended.map(entry => entry.data), [{ key: "geoip" }]);
  assert.equal(existsSync(join(h.loadedDir, "geoip")), true);

  h.writeBrief("geoip", "revised allocation notes", "CLOUD-4028");
  const second = await injected(h);
  assert.match(second.systemPrompt.at(-1), /revised allocation notes/);
  assert.doesNotMatch(second.systemPrompt.at(-1), /initial allocation notes/);
});

test("start, branch and tree restore recorded selections around compaction entries", async t => {
  const alphaEntry = { type: "custom", customType: ENTRY_TYPE, data: { key: "alpha" } };
  const compacted = { type: "custom", customType: "omp.compaction", data: { summary: "trimmed" } };
  const h = await host(t, { entries: [alphaEntry, compacted] });
  h.writeBrief("alpha", "alpha notes");
  h.writeBrief("beta", "beta notes");

  await h.handlers.session_start({}, h.context);
  assert.match((await injected(h)).systemPrompt.at(-1), /alpha notes/);

  h.setBranch([{ type: "custom", customType: ENTRY_TYPE, data: { key: "beta" } }]);
  await h.handlers.session_branch({}, h.context);
  assert.match((await injected(h)).systemPrompt.at(-1), /beta notes/);

  h.setBranch([alphaEntry, compacted]);
  await h.handlers.session_tree({}, h.context);
  assert.match((await injected(h)).systemPrompt.at(-1), /alpha notes/);
  assert.equal(h.appended.length, 0);
});

test("a new session keeps and records the current brief", async t => {
  const h = await host(t, { flag: "alpha" });
  h.writeBrief("alpha", "alpha notes");
  await h.handlers.session_start({}, h.context);

  h.appended.length = 0;
  h.setBranch([]);
  await h.handlers.session_switch({ reason: "new" }, h.context);

  assert.deepEqual(h.appended.map(entry => entry.data), [{ key: "alpha" }]);
  assert.match((await injected(h)).systemPrompt.at(-1), /alpha notes/);
});

test("brief off records an explicit empty selection and stops injection", async t => {
  const h = await host(t, { flag: "alpha" });
  h.writeBrief("alpha", "alpha notes");
  await h.handlers.session_start({}, h.context);

  await h.command("off", h.context);

  assert.deepEqual(h.appended.at(-1).data, { key: null });
  assert.equal(await injected(h), undefined);
  assert.deepEqual(h.notifications.at(-1), { message: "Unloaded brief alpha.", level: "info" });
});

test("a brief that becomes missing, archived or malformed unloads with a warning", async t => {
  for (const state of ["missing", "archived", "malformed"]) {
    const h = await host(t, { flag: "alpha" });
    h.writeBrief("alpha", "alpha notes");
    await h.handlers.session_start({}, h.context);

    const active = join(h.activeDir, "alpha.md");
    if (state === "archived") renameSync(active, join(h.archiveDir, "alpha.md"));
    else if (state === "malformed") writeFileSync(active, "---\njira: not-a-key\n---\nnotes\n");
    else rmSync(active);

    assert.equal(await injected(h), undefined, state);
    assert.equal(h.notifications.at(-1).level, "warning", state);
    assert.match(h.notifications.at(-1).message, /unloaded/, state);
    assert.equal(h.statuses.at(-1).value, undefined, state);
  }
});

test("subagents neither restore nor inject briefs", async t => {
  const entries = [{ type: "custom", customType: ENTRY_TYPE, data: { key: "alpha" } }];
  const h = await host(t, { flag: "alpha", entries, agentKind: "sub" });
  h.writeBrief("alpha", "alpha notes");

  await h.handlers.session_start({}, h.context);

  assert.equal(await injected(h), undefined);
  assert.equal(h.appended.length, 0);
  assert.equal(h.statuses.length, 0);
  assert.equal(existsSync(join(h.loadedDir, "alpha")), false);
});

test("the command-line flag is consumed only by the startup session", async t => {
  const h = await host(t, { flag: "alpha" });
  h.writeBrief("alpha", "alpha notes");
  h.writeBrief("beta", "beta notes");
  await h.handlers.session_start({}, h.context);

  h.setBranch([{ type: "custom", customType: ENTRY_TYPE, data: { key: "beta" } }]);
  await h.handlers.session_switch({ reason: "resume" }, h.context);

  assert.match((await injected(h)).systemPrompt.at(-1), /beta notes/);
  assert.doesNotMatch((await injected(h)).systemPrompt.at(-1), /alpha notes/);
});
