import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const launcher = fileURLToPath(new URL("./start.mjs", import.meta.url));
const selector = "openai-codex/gpt-6.1-sol";
const document = "# Handoff: fixture\n\nA bounded test mission.\n";

// The fake tern knows the parent pane 41 and the new block 3. A split records its argv and
// starts the program as tern would; POSIX sh stands in for the user's interactive shell.
// Block 3 reports omp as its program once the fake omp has started.
const fakeTern = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const root = process.env.TEST_ROOT;
const [command, ...args] = process.argv.slice(2);
if (command === "split") {
  appendFileSync(root + "/splits.jsonl", JSON.stringify(args) + "\\n");
  if (process.env.TEST_SPLIT === "fail") {
    console.error("fixture split failure");
    process.exit(1);
  }
  const [, , , script, ...positional] = args.slice(args.indexOf("--") + 1);
  spawnSync("/bin/sh", ["-c", script, ...positional], { cwd: args[args.indexOf("--cwd") + 1], stdio: "ignore" });
  console.log(JSON.stringify({ session: 1, tab: 2, block: 3 }));
} else if (command === "process" && args[0] === "41") {
  console.log(JSON.stringify({ pane: 41, child: { name: "zsh", argv: ["/bin/zsh", "-l"] } }));
} else if (command === "process" && args[0] === "3") {
  const started = existsSync(root + "/started.json") ? JSON.parse(readFileSync(root + "/started.json", "utf8")) : null;
  console.log(JSON.stringify({ pane: 3, child: started && { name: "omp", argv: started.argv } }));
} else if (command === "process") {
  console.error("tern process: no block is called " + args[0]);
  process.exit(1);
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
  const result = spawnSync(program, rest, { stdio: "inherit", env: { ...process.env, TEST_DIRENV_DIR: directory } });
  process.exit(result.status ?? 1);
} else process.exit(9);
`;
const fakeOmp = `
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "models") {
  console.log(process.env.TEST_MODELS ?? JSON.stringify({ models: [
    { selector: "${selector}", id: "gpt-6.1-sol", name: "GPT-6.1-Sol", thinking: ["high"] }] }));
} else {
  const documents = args.filter(arg => arg.startsWith("@"));
  if (process.env.TEST_OMP === "fail" || documents.length !== 1
    || !readFileSync(documents[0].slice(1), "utf8").includes("A bounded test mission.")) process.exit(5);
  writeFileSync(process.env.TEST_ROOT + "/started.json", JSON.stringify({ argv: [process.argv[1], ...args],
    direnv: process.env.TEST_DIRENV_DIR }));
}
`;

function fixture(t, name = "handoff.md") {
  const root = mkdtempSync(join(tmpdir(), "handoff-test-"));
  const bin = join(root, "bin");
  const overlays = join(root, "tmp");
  mkdirSync(bin);
  mkdirSync(overlays);
  const file = join(root, name);
  writeFileSync(file, document);
  for (const [command, source] of Object.entries({ tern: fakeTern, direnv: fakeDirenv, omp: fakeOmp })) {
    writeFileSync(join(bin, command), `#!${process.execPath}\n${source}`, { mode: 0o700 });
  }
  // PATH holds only the fakes, so a test can never reach the real tern daemon.
  const env = { ...process.env, PATH: bin, TMPDIR: overlays, TERN_PANE: "41", TEST_ROOT: root };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const splits = () => existsSync(join(root, "splits.jsonl"))
    ? readFileSync(join(root, "splits.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
    : [];
  return { root, bin, file, env, overlays, splits };
}

function launch(context, args = []) {
  return spawnSync(process.execPath, [launcher, "--file", context.file, "--cwd", context.root, ...args],
    { env: context.env, cwd: context.root, encoding: "utf8", timeout: 20000 });
}

test("a launch starts omp once in a new tern pane with the document, model and fresh overlay", t => {
  const context = fixture(t, "handoff ' $(touch unowned).md");
  const result = launch(context, ["--model", "GPT 6.1 Sol High"]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, "launched");
  assert.equal(receipt.block, 3);
  assert.equal(readFileSync(receipt.config, "utf8"), "autoResume: false\n");
  const [split, ...retries] = context.splits();
  assert.deepEqual(retries, []);
  const separator = split.indexOf("--");
  assert.deepEqual(split.slice(0, separator), ["41", "right", "--cwd", context.root, "--json"]);
  // An interactive shell reads the rc files, where zsh sources secrets.env.
  assert.deepEqual(split.slice(separator + 1, separator + 4), [userInfo().shell, "-i", "-c"]);
  const started = JSON.parse(readFileSync(join(context.root, "started.json"), "utf8"));
  assert.deepEqual(started.argv, [join(context.bin, "omp"), "--config", receipt.config, "--cwd", context.root,
    "--model", selector, "--thinking", "high", `@${context.file}`]);
  assert.equal(started.direnv, context.root);
  assert.equal(existsSync(join(context.root, "unowned")), false);
});

test("--check resolves the model without writing an overlay or opening a pane", t => {
  const context = fixture(t);
  const result = launch(context, ["--check", "--model", "GPT 6.1 Sol High"]);
  assert.equal(result.status, 0, result.stderr);
  const validated = JSON.parse(result.stdout);
  assert.equal(validated.status, "validated");
  assert.equal(validated.model, selector);
  assert.equal(validated.thinking, "high");
  assert.deepEqual(context.splits(), []);
  assert.deepEqual(readdirSync(context.overlays), []);
});

test("outside a known tern pane the launcher refuses before writing anything", t => {
  const context = fixture(t);
  for (const pane of [undefined, "42"]) {
    if (pane) context.env.TERN_PANE = pane;
    else delete context.env.TERN_PANE;
    const result = launch(context);
    assert.equal(result.status, 1);
    assert.match(result.stderr, pane ? /no block is called 42/ : /only inside a tern pane/);
    assert.match(result.stderr, /No successor was started/);
  }
  assert.deepEqual(context.splits(), []);
  assert.deepEqual(readdirSync(context.overlays), []);
  assert.equal(readFileSync(context.file, "utf8"), document);
});

test("an .envrc that direnv has not allowed stops the launch before opening a pane", t => {
  const context = fixture(t);
  context.env.TEST_DIRENV = "blocked";
  const result = launch(context);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /direnv allow/);
  assert.deepEqual(context.splits(), []);
  assert.deepEqual(readdirSync(context.overlays), []);
});

test("a successor that exits during startup is not reported as launched", t => {
  const context = fixture(t);
  context.env.TEST_OMP = "fail";
  const result = launch(context);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /omp exited during startup/);
  assert.match(result.stderr, /tern capture 3 --surfaces/);
  assert.equal(context.splits().length, 1);
});

test("a failed split is reported for inspection and never retried", t => {
  const context = fixture(t);
  context.env.TEST_SPLIT = "fail";
  const result = launch(context);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tern ls --json/);
  assert.equal(context.splits().length, 1);
});

test("ambiguous models and unsupported thinking levels are rejected before opening a pane", t => {
  const context = fixture(t);
  context.env.TEST_MODELS = JSON.stringify({ models: [
    { selector, id: "gpt-6.1-sol", name: "GPT-6.1-Sol", thinking: ["high"] },
    { selector: "another/gpt-6.1-sol", id: "gpt-6.1-sol", name: "GPT-6.1-Sol", thinking: ["high"] },
  ] });
  const ambiguous = launch(context, ["--model", "GPT 6.1 Sol"]);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /Ambiguous model/);
  delete context.env.TEST_MODELS;
  const unsupported = launch(context, ["--model", selector, "--thinking", "low"]);
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /does not support thinking low/);
  assert.deepEqual(context.splits(), []);
});

test("--help succeeds and unknown options still fail", () => {
  const help = spawnSync(process.execPath, [launcher, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--file <path>/);
  const unknown = spawnSync(process.execPath, [launcher, "--transport", "tmux"], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option '--transport'/);
});
