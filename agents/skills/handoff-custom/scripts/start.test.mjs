import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const launcher = fileURLToPath(new URL("./start.mjs", import.meta.url));
const selector = "openai-codex/gpt-6.1-sol";
const nativeModels = [{ id: selector, model: "GPT-6.1-Sol", thinkingOptionIds: ["low", "high"] }];

function fixture(t, name = "handoff.md") {
  const root = mkdtempSync(join(tmpdir(), "handoff-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const file = join(root, name);
  writeFileSync(file, "# Handoff: fixture\n\nA bounded test mission.\n");
  const attempts = join(root, "attempts");
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, TMPDIR: root,
    TEST_ATTEMPTS: attempts, TEST_NATIVE_MODELS: JSON.stringify(nativeModels), TEST_PARENT: "1 launchd" };
  for (const key of ["TMUX", "TMUX_PANE", "PASEO_AGENT_ID", "PASEO_WORKSPACE_ID"]) delete env[key];
  writeFileSync(join(bin, "ps"), `#!${process.execPath}\nconsole.log(process.env.TEST_PARENT);\n`, { mode: 0o700 });
  writeFileSync(join(bin, "omp"), `#!${process.execPath}
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'models') {
  console.log(JSON.stringify({ models: [{ selector: '${selector}', id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', thinking: ['high'] }] }));
} else {
  const file = args.find(value => value.startsWith('@'))?.slice(1);
  if (!file || !readFileSync(file, 'utf8').includes('A bounded test mission.')) process.exit(5);
  console.log('fixture launched');
}
`, { mode: 0o700 });
  writeFileSync(join(bin, "paseo"), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'provider') {
  console.log(process.env.TEST_NATIVE_MODELS);
} else if (args[0] === 'run') {
  appendFileSync(process.env.TEST_ATTEMPTS, 'create\\n');
  console.log(process.env.TEST_RECEIPT ?? JSON.stringify({ agentId: 'fixture-agent', provider: 'omp',
    cwd: args[args.indexOf('--cwd') + 1], status: 'running', title: 'Fixture successor' }));
} else process.exit(6);
`, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, file, attempts, env };
}

function launch(context, args = []) {
  return spawnSync(process.execPath, [launcher, "--file", context.file, "--cwd", context.root, ...args],
    { env: context.env, cwd: context.root, encoding: "utf8", timeout: 10000 });
}

test("Paseo context takes precedence over inherited tmux context", t => {
  const context = fixture(t);
  Object.assign(context.env, { PASEO_AGENT_ID: "parent", TMUX: "inherited", TMUX_PANE: "%7" });
  const result = launch(context, ["--check", "--model", "GPT 6.1 Sol High"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).transport, "paseo");
  assert.equal(existsSync(context.attempts), false);
});

test("native Paseo ancestry launches a successor even when tool environment markers are missing", t => {
  const context = fixture(t);
  context.env.TEST_PARENT = "1 Paseo Daemon";
  const result = launch(context);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, "launched");
  assert.equal(receipt.transport, "paseo");
  assert.equal(readFileSync(context.attempts, "utf8"), "create\n");
});

test("an ordinary terminal remains manual despite having Paseo installed", t => {
  const context = fixture(t);
  const result = launch(context);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "manual");
  assert.equal(existsSync(context.attempts), false);
});

test("forced tmux cannot launch into an unspecified pane", t => {
  const context = fixture(t);
  const result = launch(context, ["--transport", "tmux"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires TMUX and a valid TMUX_PANE/);
  assert.equal(existsSync(context.attempts), false);
});

test("Paseo's own thinking catalog prevents an incompatible launch even if omp supports it", t => {
  const context = fixture(t);
  context.env.TEST_NATIVE_MODELS = JSON.stringify([{ ...nativeModels[0], thinkingOptionIds: ["low"] }]);
  const result = launch(context, ["--transport", "paseo", "--model", "GPT 6.1 Sol High"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not support thinking high/);
  assert.equal(existsSync(context.attempts), false);
});

test("Paseo cannot inherit omp-only implicit thinking levels", t => {
  const context = fixture(t);
  const result = launch(context, ["--transport", "paseo", "--model", selector, "--thinking", "auto"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not support thinking auto/);
  assert.equal(existsSync(context.attempts), false);
});

test("an ambiguous native model is rejected before creating a session", t => {
  const context = fixture(t);
  context.env.TEST_NATIVE_MODELS = JSON.stringify([...nativeModels, { ...nativeModels[0], id: "another/gpt-6.1-sol" }]);
  const result = launch(context, ["--transport", "paseo", "--model", "GPT 6.1 Sol High"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Ambiguous model/);
  assert.equal(existsSync(context.attempts), false);
});

test("an uncertain native creation receipt preserves the snapshot and never retries", t => {
  const context = fixture(t);
  context.env.TEST_RECEIPT = JSON.stringify({ status: "running" });
  const result = launch(context, ["--transport", "paseo"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Creation may have succeeded/);
  assert.equal(readFileSync(context.attempts, "utf8"), "create\n");
  assert.equal(existsSync(context.file), true);
});

test("manual shell commands preserve quoted document paths without executing their contents", t => {
  const context = fixture(t, "handoff ' $(touch unowned).md");
  const result = launch(context, ["--transport", "manual"]);
  assert.equal(result.status, 0, result.stderr);
  const started = spawnSync("/bin/sh", ["-c", JSON.parse(result.stdout).command],
    { env: context.env, cwd: context.root, encoding: "utf8" });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stdout.trim(), "fixture launched");
  assert.equal(existsSync(join(context.root, "unowned")), false);
});
