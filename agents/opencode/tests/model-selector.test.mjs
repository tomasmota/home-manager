import assert from "node:assert/strict"
import test from "node:test"

import { selectModel } from "../../skills/model-selector/scripts/select.mjs"

const healthyQuota = { openai: { percentLeft: 50, hourly: { percentLeft: 50 } } }
const lowQuota = { openai: { percentLeft: 50, hourly: { percentLeft: 19 } } }

test("selects Terra workhorse while OpenAI quota is healthy", async () => {
  const result = await selectModel("A concrete planned implementation.", {
    quota: healthyQuota,
    request: async ({ questions }) => {
      assert.ok(Object.hasOwn(questions.profile.criteria, "workhorse"))
      assert.ok(!Object.hasOwn(questions.profile.criteria, "workhorse-zai"))
      return { answers: { profile: { type: "choice", choice: "workhorse", confidence: 0.9 } } }
    },
  })
  assert.equal(result.model, "openai/gpt-5.6-terra")
  assert.equal(result.effort, "medium")
})

test("uses GLM workhorse candidate when OpenAI 5-hour quota is low", async () => {
  const result = await selectModel("A concrete planned implementation.", {
    quota: lowQuota,
    request: async ({ questions }) => {
      assert.ok(Object.hasOwn(questions.profile.criteria, "workhorse-zai"))
      assert.ok(!Object.hasOwn(questions.profile.criteria, "workhorse"))
      return { answers: { profile: { type: "choice", choice: "workhorse-zai", confidence: 0.9 } } }
    },
  })
  assert.equal(result.model, "zai-coding-plan/glm-5.3")
  assert.equal(result.effort, "high")
})

test("falls back to the quota-aware workhorse when Jev is unavailable", async () => {
  const result = await selectModel("A concrete planned implementation.", {
    quota: lowQuota,
    request: async () => {
      throw new Error("unavailable")
    },
  })
  assert.equal(result.profile, "workhorse-zai")
  assert.equal(result.source, "fallback")
})
