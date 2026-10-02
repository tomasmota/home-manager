import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

const skill = await readFile(new URL("../../skills/handoff/SKILL.md", import.meta.url), "utf8")
const recipe = skill.match(/```bash\n(worktree=[\s\S]*?)\n```/)?.[1]
assert.ok(recipe, "the documented spawn recipe must remain executable")
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`

async function runRecipe({ attach = false, tmux = false, paneFailure = false, promptFailure = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-handoff-test-"))
  try {
    const file = join(directory, "handoff.md")
    const log = join(directory, "calls.jsonl")
    await writeFile(file, "Continue this fictional task.\nPreserve its state.\n")
    for (const command of ["opencode", "tmux"]) {
      const path = join(directory, command)
      await writeFile(path, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_LOG, JSON.stringify({command:${JSON.stringify(command)},args})+'\\n');
if (${JSON.stringify(command)} === 'tmux') process.exit(process.env.PANE_FAILURE === '1' ? 1 : 0);
if (args[0] === 'api' && args[2] === '/api/session') console.log(JSON.stringify({data:{id:'ses_mock'}}));
if (args[0] === 'api' && args[2]?.endsWith('/prompt')) process.exit(process.env.PROMPT_FAILURE === '1' ? 1 : 0);
`)
      await chmod(path, 0o755)
    }
    const script = recipe
      .replace(/^worktree=.*$/m, `worktree=${quote(directory)}`)
      .replace(/^file=.*$/m, `file=${quote(file)}`)
      .replace(/^attach_tmux=.*$/m, `attach_tmux=${attach}`)
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      timeout: 10000,
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        HOME: directory,
        TEST_LOG: log,
        TMUX: tmux ? "fictional-tmux" : "",
        TMUX_PANE: tmux ? "%9" : "",
        PANE_FAILURE: paneFailure ? "1" : "0",
        PROMPT_FAILURE: promptFailure ? "1" : "0",
      },
    })
    assert.ifError(result.error)
    const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    return { ...result, calls }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("app handoff starts one successor and never opens a tmux pane", async () => {
  const result = await runRecipe()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Handoff session: ses_mock/)
  assert.equal(result.calls.filter((call) => call.command === "tmux").length, 0)
  assert.equal(result.calls.filter((call) => call.args[2]?.endsWith("/prompt")).length, 1)
})

test("app presentation ignores inherited tmux variables", async () => {
  const result = await runRecipe({ tmux: true })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.calls.filter((call) => call.command === "tmux").length, 0)
})

test("confirmed tmux presentation opens the owning pane", async () => {
  const result = await runRecipe({ tmux: true, attach: true })
  assert.equal(result.status, 0, result.stderr)
  const panes = result.calls.filter((call) => call.command === "tmux")
  assert.equal(panes.length, 1)
  assert.equal(panes[0].args[panes[0].args.indexOf("-t") + 1], "%9")
})

test("a pane failure is a warning, not a failed or duplicated successor", async () => {
  const result = await runRecipe({ tmux: true, attach: true, paneFailure: true })
  assert.equal(result.status, 0)
  assert.match(result.stderr, /already running/)
  assert.equal(result.calls.filter((call) => call.args[2] === "/api/session").length, 1)
  assert.equal(result.calls.filter((call) => call.args[2]?.endsWith("/prompt")).length, 1)
  assert.equal(result.calls.filter((call) => call.args[0] === "session").length, 0)
})

test("an uncertain prompt receipt preserves the successor for inspection, without retrying", async () => {
  const result = await runRecipe({ promptFailure: true })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /receipt uncertain for session ses_mock/)
  assert.equal(result.calls.filter((call) => call.args[0] === "session").length, 0)
  assert.equal(result.calls.filter((call) => call.command === "tmux").length, 0)
})

test("both configs select search server-side and omit the deleted package", async () => {
  for (const name of ["opencode.json", "opencode.macos.json"]) {
    const config = JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), "utf8"))
    assert.equal(config.websearch.provider, "exa")
    assert.ok(config.plugins.every((item) => !(typeof item === "string" ? item : item.package).includes("compaction-preserve")))
  }
})

test("handoff model resolution has no fixed generation alias table", () => {
  assert.ok(!skill.includes("`sol` ->"))
  assert.match(skill, /current model catalog/)
})
