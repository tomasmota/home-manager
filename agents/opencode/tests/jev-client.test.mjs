import assert from "node:assert/strict"
import test from "node:test"

import { answerChoice, answerNoul, answerScore, requestJev } from "../plugins/lib/jev-client.js"

test("parses Jev primitive answers", () => {
  assert.equal(answerNoul({ type: "noul", noul: 0.8 }), 0.8)
  assert.deepEqual(answerChoice({ type: "choice", choice: "done", confidence: 0.9, probabilities: { done: 0.9 } }), {
    choice: "done",
    confidence: 0.9,
    probabilities: { done: 0.9 },
  })
  assert.deepEqual(answerScore({ type: "score", score: 2.5, confidence: 0.7, probabilities: { 2: 0.5, 3: 0.5 } }), {
    score: 2.5,
    confidence: 0.7,
    probabilities: { 2: 0.5, 3: 0.5 },
  })
})

test("sends a typed Jev request", async () => {
  const requests = []
  const response = await requestJev({
    state: { message: "finished" },
    questions: { complete: { type: "noul", instructions: "Is it complete?" } },
    apiKey: "test-key",
    model: "jev-test",
    fetchFn: async (url, options) => {
      requests.push({ url, options })
      return new Response(JSON.stringify({ model: "jev-test", answers: {}, usage: {} }), { status: 200 })
    },
  })
  assert.equal(response.model, "jev-test")
  assert.equal(requests.length, 1)
  assert.match(requests[0].options.headers.Authorization, /test-key/)
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    model: "jev-test",
    state: { message: "finished" },
    questions: { complete: { type: "noul", instructions: "Is it complete?" } },
  })
})
