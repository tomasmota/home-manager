import assert from "node:assert/strict"
import test from "node:test"

import { loadSecretsEnv, answerChoice, answerNoul, answerScore, requestJev } from "../plugins/lib/jev-client.js"

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

test("falls back to the secrets env file when TYPESAFE_API_KEY is unset", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const dir = await mkdtemp(join(tmpdir(), "jev-client-test-"))
  const path = join(dir, "secrets.env")
  await writeFile(
    path,
    '# comment line\nexport TYPESAFE_API_KEY="file-key"\nOTHER_KEY = unquoted value\nbroken line\n',
    "utf8",
  )
  const previous = process.env.TYPESAFE_API_KEY
  const previousSecretsFile = process.env.OPENCODE_SECRETS_FILE
  delete process.env.TYPESAFE_API_KEY
  process.env.OPENCODE_SECRETS_FILE = path
  const requests = []
  try {
    await requestJev({
      state: { message: "finished" },
      questions: { complete: { type: "noul", instructions: "Is it complete?" } },
      model: "jev-test",
      fetchFn: async (url, options) => {
        requests.push({ url, options })
        return new Response(JSON.stringify({ model: "jev-test", answers: {}, usage: {} }), { status: 200 })
      },
    })
    const secrets = await loadSecretsEnv(path)
    assert.equal(secrets.TYPESAFE_API_KEY, "file-key")
    assert.equal(secrets.OTHER_KEY, "unquoted value")
    assert.equal(Object.hasOwn(secrets, "broken"), false)
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previous
    if (previousSecretsFile === undefined) delete process.env.OPENCODE_SECRETS_FILE
    else process.env.OPENCODE_SECRETS_FILE = previousSecretsFile
    await rm(dir, { recursive: true, force: true })
  }
  assert.equal(requests.length, 1)
  assert.match(requests[0].options.headers.Authorization, /file-key/)
})

test("prefers the environment over the secrets env file", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const dir = await mkdtemp(join(tmpdir(), "jev-client-test-"))
  const path = join(dir, "secrets.env")
  await writeFile(path, 'export TYPESAFE_API_KEY="file-key"\n', "utf8")
  const previous = process.env.TYPESAFE_API_KEY
  process.env.TYPESAFE_API_KEY = "env-key"
  const requests = []
  try {
    await requestJev({
      state: {},
      questions: {},
      model: "jev-test",
      fetchFn: async (url, options) => {
        requests.push({ url, options })
        return new Response("{}", { status: 200 })
      },
    })
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previous
    await rm(dir, { recursive: true, force: true })
  }
  assert.match(requests[0].options.headers.Authorization, /env-key/)
})
