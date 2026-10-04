import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const root = resolve(".")
const read = (path) => readFile(resolve(root, path), "utf8")
const skills = ["install-skill", "create-skill"]

test("install-skill and create-skill are not generated inventory-owned", async () => {
  for (const profile of ["mac"]) {
    const inventory = JSON.parse(await read(`agents/config/inventory.${profile}.json`))
    for (const name of skills) {
      assert.equal(name in inventory.skills, false, `${name} in ${profile} skills`)
      assert.equal(Object.keys(inventory.artifacts).some((p) => p.startsWith(`agents/skills/${name}/`)), false, `${name} in ${profile} artifacts`)
    }
  }
})

test("skills describe three ownership classes instead of one destination", async () => {
  for (const name of skills) {
    const text = await read(`agents/skills/${name}/SKILL.md`)
    const frontmatter = text.split(/^---$/m)[1]
    assert.doesNotMatch(frontmatter, /canonical_skills_dir/)
    for (const needle of ["tomasmota/agents", "manifest", "inventory.mac.json", "~/.agents/local-skills", "team-skills"]) {
      assert.ok(text.includes(needle), `${name} missing ${needle}`)
    }
    assert.doesNotMatch(text, /inventory\.linux\.json/)
    assert.match(text, /generated/i)
    assert.match(text, /uvx --from skills-ref agentskills validate/)
    assert.doesNotMatch(text, /pip install/)
    assert.doesNotMatch(text, /Destination must be/)
    assert.doesNotMatch(text, /Tracked edits belong in/)
  }
})

test("install-skill keeps no single hardcoded destination claim", async () => {
  const text = await read("agents/skills/install-skill/SKILL.md")
  const frontmatter = text.split(/^---$/m)[1]
  assert.doesNotMatch(frontmatter, /Places skills in/)
  assert.doesNotMatch(text, /Install into repo source, not runtime mirror/)
  assert.match(text, /Never commit, push, publish, or install to a target the user did not request/)
  assert.match(text, /Never overwrite a generated skill/)
  assert.match(text, /Ask|ask/)
})
