import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  const exec = (command, args, options) => {
    const result = spawnSync(command, args, { ...options, encoding: "utf8" });
    if (result.error) throw result.error;
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const pi = {
    registerFlag() {},
    getFlag: () => flag,
    exec,
    on(name, handler) { handlers[name] = handler; },
    registerCommand(_name, definition) { command = definition; },
    appendEntry(customType, data) {
      const entry = { type: "custom", customType, data };
      branch.push(entry);
      appended.push(entry);
    },
    logger: { warn(message, data) { warnings.push({ message, data }); } },
  };
  const context = {
    cwd: root,
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
    command: (...args) => command.handler(...args),
    cli(...args) {
      return spawnSync("bash", ["-euo", "pipefail", fileURLToPath(new URL("./brief.sh", import.meta.url)), ...args], {
        cwd: context.cwd,
        encoding: "utf8",
        env: { ...process.env, XDG_DATA_HOME: dataHome, XDG_STATE_HOME: stateHome,
          GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig") },
      });
    },
    completions: prefix => command.getArgumentCompletions(prefix),
    context,
    handlers,
    git(...args) {
      const result = exec("git", args, { cwd: context.cwd });
      assert.equal(result.code, 0, result.stderr);
    },
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

test("startup flag injects the brief with its file path and edits appear on the next turn", async t => {
  const h = await host(t, { flag: "geoip" });
  h.writeBrief("geoip", "initial allocation notes", "CLOUD-4028");

  await h.handlers.session_start({}, h.context);
  const first = await injected(h);
  assert.deepEqual(first.systemPrompt.slice(0, -1), ["base prompt"]);
  assert.match(first.systemPrompt.at(-1), /<brief key="geoip">/);
  assert.match(first.systemPrompt.at(-1), /Jira epic CLOUD-4028/);
  assert.match(first.systemPrompt.at(-1), /initial allocation notes/);
  assert.ok(first.systemPrompt.at(-1).includes(join(h.activeDir, "geoip.md")));
  assert.deepEqual(h.appended.map(entry => entry.data), [{ keys: ["geoip"] }]);
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

  assert.deepEqual(h.appended.map(entry => entry.data), [{ keys: ["alpha"] }]);
  assert.match((await injected(h)).systemPrompt.at(-1), /alpha notes/);
});

test("brief off records an explicit empty selection and stops injection", async t => {
  const h = await host(t, { flag: "alpha" });
  h.writeBrief("alpha", "alpha notes");
  await h.handlers.session_start({}, h.context);

  await h.command("off", h.context);

  assert.deepEqual(h.appended.at(-1).data, { keys: [] });
  assert.equal(await injected(h), undefined);
});

test("a brief that becomes missing or archived unloads with a warning", async t => {
  for (const state of ["missing", "archived"]) {
    const h = await host(t, { flag: "alpha" });
    h.writeBrief("alpha", "alpha notes");
    await h.handlers.session_start({}, h.context);

    const active = join(h.activeDir, "alpha.md");
    if (state === "archived") renameSync(active, join(h.archiveDir, "alpha.md"));
    else rmSync(active);

    assert.equal(await injected(h), undefined, state);
    assert.equal(h.notifications.at(-1).level, "warning", state);
    assert.equal(h.statuses.at(-1).value, undefined, state);
  }
});

test("a malformed brief stays loaded, showing the agent its path and error until fixed", async t => {
  const h = await host(t, { flag: "alpha" });
  h.writeBrief("alpha", "alpha notes");
  await h.handlers.session_start({}, h.context);
  const file = join(h.activeDir, "alpha.md");
  const warnings = () => h.notifications.filter(({ level }) => level === "warning").length;
  const breakBrief = () => writeFileSync(file, "---\ntitle: alpha\n---\nalpha notes\n");
  const assertBroken = async label => {
    const prompt = (await injected(h)).systemPrompt.at(-1);
    assert.ok(prompt.includes(file), label);
    assert.match(prompt, /unknown front matter line 'title: alpha'/, label);
    assert.doesNotMatch(prompt, /alpha notes/, label);
  };

  breakBrief();
  await assertBroken("first turn");
  await assertBroken("second turn");
  await h.handlers.session_switch({ reason: "resume" }, h.context);
  await assertBroken("after resume");
  assert.equal(warnings(), 1);
  assert.match(h.statuses.at(-1).value, /alpha/);

  h.writeBrief("alpha", "repaired notes");
  assert.match((await injected(h)).systemPrompt.at(-1), /repaired notes/);
  breakBrief();
  await assertBroken("broken again");
  assert.equal(warnings(), 2);
  assert.deepEqual(h.appended.map(entry => entry.data), [{ keys: ["alpha"] }]);
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

test("repo defaults load from subdirectories without leaking to another repo", async t => {
  const h = await host(t);
  h.writeBrief("default-context", "repository background");
  h.git("init", "--quiet");
  h.git("config", "--local", "omp.brief", "default-context");
  const root = h.context.cwd;
  h.context.cwd = join(root, "src");
  mkdirSync(h.context.cwd);

  await h.handlers.session_start({}, h.context);

  assert.match((await injected(h)).systemPrompt.at(-1), /repository background/);
  assert.deepEqual(h.appended.map(entry => entry.data), [{ keys: ["default-context"] }]);

  h.context.cwd = join(root, "other-repo");
  mkdirSync(h.context.cwd);
  h.git("init", "--quiet");
  h.setBranch([]);
  await h.handlers.session_switch({ reason: "resume" }, h.context);

  assert.equal(await injected(h), undefined);
  assert.deepEqual(h.context.sessionManager.getBranch(), []);
});

test("explicit flags and saved choices take precedence over repo defaults", async t => {
  for (const { flag, saved, expected } of [
    { flag: "explicit", saved: "saved", expected: "explicit" },
    { saved: "saved", expected: "saved" },
    { saved: null },
    { saved: "missing" },
  ]) {
    const entries = [{ type: "custom", customType: ENTRY_TYPE, data: { key: saved } }];
    const h = await host(t, { flag, entries });
    for (const key of ["default-context", "explicit", "saved"]) h.writeBrief(key, `${key} background`);
    h.git("init", "--quiet");
    h.git("config", "--local", "omp.brief", "default-context");

    await h.handlers.session_start({}, h.context);

    const result = await injected(h);
    if (expected) assert.match(result.systemPrompt.at(-1), new RegExp(`${expected} background`));
    else assert.equal(result, undefined);
  }
});

test("brief off persists across new sessions and resume despite a repo default", async t => {
  const h = await host(t);
  h.writeBrief("default-context", "repository background");
  h.git("init", "--quiet");
  h.git("config", "--local", "omp.brief", "default-context");
  await h.handlers.session_start({}, h.context);
  await h.command("off", h.context);
  assert.deepEqual(h.appended.at(-1).data, { keys: [] });

  h.setBranch([]);
  await h.handlers.session_switch({ reason: "new" }, h.context);
  assert.equal(await injected(h), undefined);
  assert.deepEqual(h.context.sessionManager.getBranch().at(-1).data, { keys: [] });

  await h.handlers.session_switch({ reason: "resume" }, h.context);
  assert.equal(await injected(h), undefined);
});

test("brief off records a choice even when nothing is loaded yet", async t => {
  const h = await host(t);
  h.writeBrief("default-context", "repository background");
  await h.handlers.session_start({}, h.context);
  await h.command("off", h.context);
  h.git("init", "--quiet");
  h.git("config", "--local", "omp.brief", "default-context");

  await h.handlers.session_switch({ reason: "resume" }, h.context);

  assert.equal(await injected(h), undefined);
  assert.deepEqual(h.context.sessionManager.getBranch().at(-1).data, { keys: [] });
});

test("adding briefs preserves order, avoids duplicates and live-reloads each file", async t => {
  const h = await host(t, { flag: "alpha" });
  h.writeBrief("alpha", "alpha background");
  h.writeBrief("beta", "beta background");
  await h.handlers.session_start({}, h.context);

  await h.command("add beta", h.context);
  await h.command("add alpha", h.context);

  const first = await injected(h);
  assert.deepEqual(first.systemPrompt.slice(1).map(part => part.match(/<brief key="([^"]+)">/)[1]), ["alpha", "beta"]);
  assert.deepEqual(h.appended.at(-1).data, { keys: ["alpha", "beta"] });
  h.writeBrief("alpha", "updated alpha background");
  h.writeBrief("beta", "updated beta background");
  const second = await injected(h);
  assert.match(second.systemPrompt[1], /updated alpha background/);
  assert.match(second.systemPrompt[2], /updated beta background/);
});

test("remove detaches only that brief and replace discards the previous selection", async t => {
  const h = await host(t, { flag: "alpha" });
  for (const key of ["alpha", "beta", "gamma"]) h.writeBrief(key, `${key} background`);
  await h.handlers.session_start({}, h.context);
  await h.command("add beta", h.context);
  await h.command("add gamma", h.context);
  await h.command("remove beta", h.context);

  assert.deepEqual((await injected(h)).systemPrompt.slice(1).map(part => part.match(/<brief key="([^"]+)">/)[1]), ["alpha", "gamma"]);
  assert.deepEqual(h.appended.at(-1).data, { keys: ["alpha", "gamma"] });

  await h.command("beta", h.context);
  const replaced = await injected(h);
  assert.deepEqual(replaced.systemPrompt.slice(1).map(part => part.match(/<brief key="([^"]+)">/)[1]), ["beta"]);
  await h.command("off", h.context);
  assert.equal(await injected(h), undefined);
  assert.deepEqual(h.appended.at(-1).data, { keys: [] });
});

test("a multi-brief selection survives resume, branch, tree and new sessions", async t => {
  const selection = { type: "custom", customType: ENTRY_TYPE, data: { keys: ["alpha", "beta"] } };
  const h = await host(t, { entries: [selection] });
  h.writeBrief("alpha", "alpha background");
  h.writeBrief("beta", "beta background");
  for (const [event, payload] of [
    ["session_start", {}],
    ["session_switch", { reason: "resume" }],
    ["session_branch", {}],
    ["session_tree", {}],
    ["session_switch", { reason: "new" }],
  ]) {
    if (payload.reason === "new") h.setBranch([]);
    await h.handlers[event](payload, h.context);
    assert.deepEqual((await injected(h)).systemPrompt.slice(1).map(part => part.match(/<brief key="([^"]+)">/)[1]), ["alpha", "beta"], event);
  }
  assert.deepEqual(h.context.sessionManager.getBranch().at(-1).data, { keys: ["alpha", "beta"] });
});

test("unusable additions leave the selection intact and an unusable brief does not unload its peers", async t => {
  const h = await host(t, { flag: "alpha,beta" });
  h.writeBrief("alpha", "alpha background");
  h.writeBrief("beta", "beta background");
  h.writeBrief("broken", "---\njira: not-an-issue\n---");
  await h.handlers.session_start({}, h.context);
  await h.command("add missing", h.context);
  await h.command("add broken", h.context);
  await h.command("remove missing", h.context);
  assert.deepEqual((await injected(h)).systemPrompt.slice(1).map(part => part.match(/<brief key="([^"]+)">/)[1]), ["alpha", "beta"]);

  rmSync(join(h.activeDir, "alpha.md"));
  const remaining = await injected(h);
  assert.deepEqual(remaining.systemPrompt.slice(1).map(part => part.match(/<brief key="([^"]+)">/)[1]), ["beta"]);
  assert.equal(h.notifications.at(-1).level, "warning");

  h.writeBrief("alpha", "restored alpha background");
  await h.handlers.session_switch({ reason: "resume" }, h.context);
  assert.deepEqual((await injected(h)).systemPrompt.slice(1).map(part => part.match(/<brief key="([^"]+)">/)[1]), ["alpha", "beta"]);
});

test("removing the last brief keeps the repo default off across new sessions", async t => {
  const h = await host(t);
  h.writeBrief("alpha", "alpha background");
  h.git("init", "--quiet");
  h.git("config", "--local", "omp.brief", "alpha");
  await h.handlers.session_start({}, h.context);
  await h.command("remove alpha", h.context);
  h.setBranch([]);
  await h.handlers.session_switch({ reason: "new" }, h.context);

  assert.equal(await injected(h), undefined);
  assert.deepEqual(h.context.sessionManager.getBranch().at(-1).data, { keys: [] });
});

test("add and remove completions reflect the loaded selection", async t => {
  const h = await host(t, { flag: "alpha" });
  h.writeBrief("alpha", "alpha background");
  h.writeBrief("beta", "beta background");
  await h.handlers.session_start({}, h.context);

  assert.deepEqual(h.completions("add ").map(item => item.value), ["add beta"]);
  assert.deepEqual(h.completions("remove ").map(item => item.value), ["remove alpha"]);
  await h.command("add beta", h.context);
  assert.equal(h.completions("add "), null);
  assert.deepEqual(h.completions("remove b").map(item => item.value), ["remove beta"]);
});

test("the CLI binds, inspects, replaces and unbinds a repo default from a subdirectory", async t => {
  const h = await host(t);
  h.writeBrief("alpha", "alpha repository background");
  h.writeBrief("beta", "beta repository background");
  h.git("init", "--quiet");
  h.context.cwd = join(h.context.cwd, "src");
  mkdirSync(h.context.cwd);

  for (const key of ["alpha", "beta"]) {
    const result = h.cli("bind", key);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(h.cli("bind").stdout.trim(), key);
    h.setBranch([]);
    await h.handlers.session_switch({ reason: "resume" }, h.context);
    assert.match((await injected(h)).systemPrompt.at(-1), new RegExp(`${key} repository background`));
  }

  const unbound = h.cli("unbind");
  assert.equal(unbound.status, 0, unbound.stderr);
  h.setBranch([]);
  await h.handlers.session_switch({ reason: "resume" }, h.context);
  assert.equal(await injected(h), undefined);
  assert.equal(h.cli("bind").status, 0);
  assert.equal(h.cli("unbind").status, 0);

  await h.command("beta", h.context);
  assert.match((await injected(h)).systemPrompt.at(-1), /beta repository background/);
});

test("the CLI refuses unusable bindings and bad arguments without changing the repo default", async t => {
  const h = await host(t);
  h.writeBrief("alpha", "original repository background");
  h.writeBrief("malformed", "---\njira: not-a-key\n---");
  writeFileSync(join(h.archiveDir, "archived.md"), "Archived background.\n");
  h.git("init", "--quiet");
  h.git("config", "--local", "omp.brief", "alpha");

  for (const args of [
    ["bind", "missing"], ["bind", "archived"], ["bind", "malformed"],
    ["bind", "../escape"], ["bind", "off"], ["bind", ""],
    ["bind", "alpha", "extra"], ["unbind", "alpha"],
  ]) {
    const result = h.cli(...args);
    assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr}`);
    h.setBranch([]);
    await h.handlers.session_switch({ reason: "resume" }, h.context);
    assert.match((await injected(h)).systemPrompt.at(-1), /original repository background/);
  }
});

test("repo binding commands refuse to run outside Git without creating a repo", async t => {
  const h = await host(t);
  h.writeBrief("alpha", "repository background");

  for (const args of [["bind", "alpha"], ["bind"], ["unbind"]]) {
    const result = h.cli(...args);
    assert.equal(result.status, 1, result.stderr);
  }

  assert.equal(existsSync(join(h.context.cwd, ".git")), false);
  await h.handlers.session_start({}, h.context);
  assert.equal(await injected(h), undefined);
});
