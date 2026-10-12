// Fictional credentials, temporary files and random loopback ports only.
// Run: node --test darwin/tern/gateway-test.mjs
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { configFromEnv, createGateway, LOCAL_WASM_PATH, WIRE_PATH } from "./gateway.mjs"

const TOKEN = "fixture-private-token-0123456789abcdef"
const ROTATED_TOKEN = "fixture-rotated-token-fedcba9876543210"
const CLIENT_TOKEN = "fixture-client-token-not-authorized"
const OWNER = "fixture-owner@example.test"
const ORIGIN = "https://gateway.example.test"
const COOKIE = "fixture-backend-cookie-private"
const DEBUG = "fixture-backend-debug-private"
const IO_TIMEOUT_MS = 3_000
const WASM = Buffer.alloc(256 * 1024, 0xa5)
WASM.set([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
const INTEGRITY = `sha384-${createHash("sha384").update(WASM).digest("base64")}`
const INDEX = `<!doctype html><html><head><link rel="preload" as="fetch" crossorigin href="${LOCAL_WASM_PATH}" integrity="${INTEGRITY}"></head><body>Fictional gateway fixture</body></html>`
const SCRIPT_PATH = "/pkg/stencil_tern_web.js"
const SCRIPT = "export const fixture = true;\n"
const BACKEND_HEAD = Buffer.from([0x81, 0x02, 0x6f, 0x6b]) // An unmasked server text frame: "ok".
const CLIENT_FRAME = Buffer.from([0x81, 0x84, 0x01, 0x02, 0x03, 0x04, 0x71, 0x6b, 0x6d, 0x63]) // Masked "ping".
const ownerHeaders = { "Tailscale-User-Login": OWNER }

function bounded(promise, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), IO_TIMEOUT_MS) }),
  ]).finally(() => clearTimeout(timer))
}

function waitFor(emitter, event, predicate, label) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer)
      emitter.off(event, check)
      if (error) reject(error)
      else resolve()
    }
    const check = () => { if (predicate()) finish() }
    const timer = setTimeout(() => finish(new Error(`${label} timed out`)), IO_TIMEOUT_MS)
    emitter.on(event, check)
    check()
  })
}

function assertNoSecrets(value) {
  const text = typeof value === "string" ? value
    : value?.body instanceof Buffer ? `${JSON.stringify(value.headers)}${value.body.toString("latin1")}`
    : JSON.stringify(value)
  for (const secret of [TOKEN, ROTATED_TOKEN, CLIENT_TOKEN, COOKIE, DEBUG, OWNER]) {
    assert.ok(!text.includes(secret), "browser responses and logs must not carry fixture credentials or identity")
  }
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "tern-gateway-test-"))
  const tokenFile = join(dir, "web-token")
  const wasmFile = join(dir, "app.wasm")
  const requests = []
  const upgrades = []
  const logs = []
  const backendSockets = new Set()
  const clientSockets = new Set()
  const control = { mode: "accept", token: TOKEN, staticMode: "normal" }
  let backend
  let gateway
  let shutdownPromise
  const shutdown = () => shutdownPromise ??= gateway ? gateway.shutdown(50) : Promise.resolve()
  t.after(async () => {
    try {
      await bounded(shutdown(), "gateway cleanup")
    } finally {
      for (const socket of clientSockets) socket.destroy()
      for (const socket of backendSockets) socket.destroy()
      try {
        if (backend?.listening) await bounded(new Promise((resolve) => backend.close(resolve)), "backend cleanup")
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
    assertNoSecrets(logs)
    for (const message of logs) {
      assert.ok(!message.includes(dir), "logs must not include private file paths")
      assert.ok(!message.includes(ORIGIN), "logs must not include request origins")
    }
  })
  await writeFile(tokenFile, `${TOKEN}\n`)
  await writeFile(wasmFile, WASM)
  backend = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers })
    const privateHeaders = { "set-cookie": `session=${COOKIE}`, "x-backend-debug": DEBUG, "x-private-token": TOKEN }
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...privateHeaders })
      return res.end(INDEX)
    }
    if (req.url === SCRIPT_PATH) {
      const status = control.staticMode === "refuse" ? 500 : 200
      res.writeHead(status, { "content-type": "text/javascript; charset=utf-8", ...privateHeaders })
      return res.end(control.staticMode === "normal" ? SCRIPT : `private backend diagnostic: token=${TOKEN}; cookie=${COOKIE}`)
    }
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("Administrative endpoint must never be reachable through the gateway")
  })
  backend.on("connection", (socket) => {
    backendSockets.add(socket)
    socket.on("close", () => backendSockets.delete(socket))
    socket.on("error", () => {})
  })
  backend.on("upgrade", (req, socket) => {
    const record = { url: req.url, headers: req.headers, socket, received: Buffer.alloc(0) }
    upgrades.push(record)
    socket.on("data", (chunk) => {
      record.received = Buffer.concat([record.received, chunk])
      backend.emit("fixture-data")
    })
    socket.on("end", () => socket.end())
    backend.emit("fixture-upgrade")
    if (control.mode === "pending") return
    const url = new URL(req.url, "http://fixture-backend.test")
    const tokens = url.searchParams.getAll("token")
    if (control.mode === "refuse" || url.pathname !== WIRE_PATH || tokens.length !== 1 || tokens[0] !== control.token || req.headers.origin !== ORIGIN) {
      const body = `private refusal: token=${control.token}; cookie=${COOKIE}; debug=${DEBUG}`
      socket.end(`HTTP/1.1 401 Unauthorized\r\nContent-Length: ${Buffer.byteLength(body)}\r\nX-Backend-Debug: ${DEBUG}\r\nSet-Cookie: session=${COOKIE}\r\n\r\n${body}`)
      return
    }
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    socket.write(Buffer.concat([
      Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Private-Token: ${control.token}\r\nSet-Cookie: session=${COOKIE}\r\nX-Backend-Debug: ${DEBUG}\r\n\r\n`),
      BACKEND_HEAD,
    ]))
  })
  backend.listen(0, "127.0.0.1")
  await bounded(once(backend, "listening"), "backend listen")
  gateway = createGateway({
    tokenFile, wasmFile, ownerLogin: OWNER, publicOrigin: ORIGIN,
    backendHost: "127.0.0.1", backendPort: backend.address().port,
    backendTimeoutMs: 1_000, log: (message) => logs.push(message),
  })
  gateway.server.listen(0, "127.0.0.1")
  await bounded(once(gateway.server, "listening"), "gateway listen")
  return { port: gateway.server.address().port, gateway, backend, requests, upgrades, control, tokenFile, clientSockets, shutdown }
}

function request(f, path, { method = "GET", headers = ownerHeaders } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: f.port, path, method, headers, agent: false }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("error", reject)
      res.on("aborted", () => reject(new Error("HTTP response aborted")))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    const timer = setTimeout(() => req.destroy(new Error("HTTP request timed out")), IO_TIMEOUT_MS)
    req.on("close", () => clearTimeout(timer))
    req.on("error", reject)
    req.end()
  })
}

// Keep one collector for the entire TCP lifetime, including coalesced upgrade/head bytes.
function rawClient(f, payload) {
  const socket = net.connect(f.port, "127.0.0.1")
  f.clientSockets.add(socket)
  let data = Buffer.alloc(0)
  let closed = false
  let error
  const readers = new Set()
  const notify = () => { for (const reader of readers) reader() }
  socket.on("data", (chunk) => { data = Buffer.concat([data, chunk]); notify() })
  socket.on("error", (failure) => { error = failure; notify() })
  socket.on("close", () => { closed = true; f.clientSockets.delete(socket); notify() })
  socket.write(payload)
  function read(select, label, allowReset = false) {
    return new Promise((resolve, reject) => {
      const finish = (failure, result) => {
        clearTimeout(timer)
        readers.delete(check)
        if (failure) reject(failure)
        else resolve(result)
      }
      const check = () => {
        const size = select(data, closed)
        if (size !== null) {
          const result = data.subarray(0, size)
          data = data.subarray(size)
          return finish(undefined, result)
        }
        if ((!allowReset && error) || closed) finish(error ?? new Error(`${label}: connection closed early`))
      }
      const timer = setTimeout(() => finish(new Error(`${label} timed out`)), IO_TIMEOUT_MS)
      readers.add(check)
      check()
    })
  }
  return {
    socket,
    head: () => read((bytes) => { const end = bytes.indexOf("\r\n\r\n"); return end < 0 ? null : end + 4 }, "WebSocket response head"),
    bytes: (count) => read((bytes) => bytes.length >= count ? count : null, "WebSocket frame"),
    closed: () => read((bytes, ended) => ended ? bytes.length : null, "connection shutdown", true),
  }
}

function handshake(path = WIRE_PATH, headers = [["Tailscale-User-Login", OWNER], ["Origin", ORIGIN]]) {
  const lines = [`GET ${path} HTTP/1.1`, "Host: gateway.example.test", "Connection: Upgrade", "Upgrade: websocket",
    "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="]
  for (const [name, value] of headers) lines.push(`${name}: ${value}`)
  return `${lines.join("\r\n")}\r\n\r\n`
}

async function deniedUpgrade(f, payload, status) {
  const client = rawClient(f, payload)
  const response = (await client.closed()).toString("latin1")
  assert.match(response, new RegExp(`^HTTP/1\\.1 ${status} `))
  assertNoSecrets(response)
}

async function admittedUpgrade(f, payload = handshake()) {
  const client = rawClient(f, payload)
  const head = (await client.head()).toString("latin1")
  assert.match(head, /^HTTP\/1\.1 101 Switching Protocols\r\n/)
  assert.match(head, /\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n/i)
  for (const name of ["set-cookie", "x-private-token", "x-backend-debug"]) assert.doesNotMatch(head, new RegExp(`\\r\\n${name}:`, "i"))
  assertNoSecrets(head)
  assert.deepEqual(await client.bytes(BACKEND_HEAD.length), BACKEND_HEAD, "upgrade head bytes survive the relay")
  return client
}

test("required environment configuration fails generically without exposing values", () => {
  const env = { TERN_TOKEN_FILE: "/fictional/private/token", TERN_WASM_FILE: "/fictional/private/app.wasm", TERN_PUBLIC_ORIGIN: ORIGIN, TERN_OWNER_LOGIN: OWNER }
  assert.deepEqual(configFromEnv(env), { tokenFile: env.TERN_TOKEN_FILE, wasmFile: env.TERN_WASM_FILE, publicOrigin: ORIGIN, ownerLogin: OWNER })
  for (const key of Object.keys(env)) {
    const incomplete = { ...env }
    delete incomplete[key]
    assert.throws(() => configFromEnv(incomplete), (error) => {
      for (const value of Object.values(env)) assert.ok(!error.message.includes(value), "configuration errors do not echo values")
      return true
    })
  }
})

test("HTTP and WebSocket reject missing, foreign and duplicated Serve identity", async (t) => {
  const f = await fixture(t)
  for (const identity of [[], [["Tailscale-User-Login", "fixture-foreign@example.test"]], [["Tailscale-User-Login", OWNER], ["Tailscale-User-Login", OWNER]]]) {
    const headers = identity.length === 0 ? {} : { "Tailscale-User-Login": identity.map(([, value]) => value) }
    const response = await request(f, "/", { headers })
    assert.equal(response.status, 403)
    assertNoSecrets(response)
    await deniedUpgrade(f, handshake(WIRE_PATH, [...identity, ["Origin", ORIGIN]]), 403)
  }
  assert.equal(f.requests.length, 0, "identity rejection happens before HTTP backend access")
  assert.equal(f.upgrades.length, 0, "identity rejection happens before token injection")
})

test("WebSocket requires the exact single Origin and HTTP rejects a foreign Origin", async (t) => {
  const f = await fixture(t)
  for (const origins of [[], [["Origin", "https://foreign.example.test"]], [["Origin", `${ORIGIN}/`]], [["Origin", ORIGIN], ["Origin", ORIGIN]]]) {
    await deniedUpgrade(f, handshake(WIRE_PATH, [["Tailscale-User-Login", OWNER], ...origins]), 403)
  }
  const response = await request(f, "/", { headers: { ...ownerHeaders, Origin: "https://foreign.example.test" } })
  assert.equal(response.status, 403)
  assertNoSecrets(response)
  assert.equal(f.requests.length, 0)
  assert.equal(f.upgrades.length, 0)
})

test("owner GET without Origin serves local WASM matching the page SRI", async (t) => {
  const f = await fixture(t)
  const page = await request(f, "/")
  assert.equal(page.status, 200)
  assert.match(page.headers["content-type"], /^text\/html/)
  const preload = page.body.toString().match(/href="([^"]+)" integrity="([^"]+)"/)
  assert.ok(preload, "the browser receives a WASM preload with integrity metadata")
  assert.equal(preload[1], LOCAL_WASM_PATH)
  const before = f.requests.length
  const wasm = await request(f, preload[1])
  assert.equal(wasm.status, 200)
  assert.equal(wasm.headers["content-type"], "application/wasm")
  assert.equal(Number(wasm.headers["content-length"]), WASM.length)
  assert.deepEqual(wasm.body, WASM)
  assert.equal(`sha384-${createHash("sha384").update(wasm.body).digest("base64")}`, preload[2])
  const head = await request(f, LOCAL_WASM_PATH, { method: "HEAD" })
  assert.equal(head.status, 200)
  assert.equal(Number(head.headers["content-length"]), WASM.length)
  assert.equal(head.body.length, 0)
  assert.equal(f.requests.length, before, "local WASM never accesses the backend")
  assertNoSecrets(page)
  assertNoSecrets(wasm)
})

test("HTTP static forwarding strips query and credentials and sanitizes responses", async (t) => {
  const f = await fixture(t)
  const response = await request(f, `${SCRIPT_PATH}?token=${CLIENT_TOKEN}&admin=true`, {
    headers: { ...ownerHeaders, Origin: ORIGIN, Cookie: `client=${CLIENT_TOKEN}`, Authorization: `Bearer ${CLIENT_TOKEN}`, "X-Forwarded-For": "192.0.2.10" },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.toString(), SCRIPT)
  for (const name of ["set-cookie", "x-backend-debug", "x-private-token"]) assert.equal(response.headers[name], undefined)
  assertNoSecrets(response)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].url, SCRIPT_PATH)
  for (const name of ["cookie", "authorization", "tailscale-user-login", "origin", "x-forwarded-for"]) assert.equal(f.requests[0].headers[name], undefined)
  for (const staticMode of ["leak", "refuse"]) {
    f.control.staticMode = staticMode
    const rejected = await request(f, SCRIPT_PATH)
    assert.equal(rejected.status, 502)
    assertNoSecrets(rejected)
    assert.doesNotMatch(rejected.body.toString(), /private backend diagnostic/)
  }
})

test("path tricks, administrative paths and plain HTTP mutations never reach the backend", async (t) => {
  const f = await fixture(t)
  for (const path of ["/api/admin", "/pkg/%2e%2e/admin", "/pkg/../admin", "//admin", "/wire/status"]) {
    assert.equal((await request(f, path)).status, 404, path)
  }
  assert.equal((await request(f, WIRE_PATH, { method: "POST" })).status, 405)
  assert.equal((await request(f, SCRIPT_PATH, { method: "DELETE" })).status, 405)
  assert.equal((await request(f, `${WIRE_PATH}?token=${CLIENT_TOKEN}`)).status, 426)
  await deniedUpgrade(f, handshake("/pkg/stencil_tern_web.js"), 404)
  assert.equal(f.requests.length, 0)
  assert.equal(f.upgrades.length, 0)
})

test("authenticated WebSocket injects only the file token, relays bytes and rereads rotation", async (t) => {
  const f = await fixture(t)
  const payload = Buffer.concat([
    Buffer.from(handshake(`${WIRE_PATH}?token=${CLIENT_TOKEN}&token=second&admin=true`, [
      ["Tailscale-User-Login", OWNER], ["Origin", ORIGIN], ["Cookie", `client=${CLIENT_TOKEN}`],
      ["Authorization", `Bearer ${CLIENT_TOKEN}`], ["Proxy-Authorization", CLIENT_TOKEN], ["X-Private-Token", CLIENT_TOKEN],
    ])),
    CLIENT_FRAME,
  ])
  const client = await admittedUpgrade(f, payload)
  assert.equal(f.upgrades.length, 1)
  const record = f.upgrades[0]
  assert.equal(record.url, `${WIRE_PATH}?token=${TOKEN}`)
  assert.equal(record.headers.origin, ORIGIN)
  for (const name of ["cookie", "authorization", "proxy-authorization", "x-private-token", "tailscale-user-login"]) assert.equal(record.headers[name], undefined)
  await waitFor(f.backend, "fixture-data", () => record.received.length >= CLIENT_FRAME.length, "early client frame")
  assert.deepEqual(record.received, CLIENT_FRAME, "client head bytes reach the authenticated tunnel without alteration")
  client.socket.destroy()
  await writeFile(f.tokenFile, `${ROTATED_TOKEN}\n`)
  f.control.token = ROTATED_TOKEN
  const rotated = await admittedUpgrade(f)
  assert.equal(f.upgrades.at(-1).url, `${WIRE_PATH}?token=${ROTATED_TOKEN}`, "a new upgrade reads the rotated token")
  rotated.socket.destroy()
})

test("missing or malformed tokens and credential-bearing backend refusals fail closed", async (t) => {
  const f = await fixture(t)
  await rm(f.tokenFile)
  await deniedUpgrade(f, handshake(), 503)
  for (const malformed of ["\n", "fixture-token\nsecond-line\n"]) {
    await writeFile(f.tokenFile, malformed)
    await deniedUpgrade(f, handshake(), 503)
  }
  assert.equal(f.upgrades.length, 0, "unusable token files do not initiate backend handshakes")
  await writeFile(f.tokenFile, `${TOKEN}\n`)
  f.control.mode = "refuse"
  await deniedUpgrade(f, handshake(), 502)
  assert.equal(f.upgrades.length, 1, "backend refusal is exercised after credential injection")
})

test("shutdown closes established tunnels and terminates pending backend handshakes", async (t) => {
  const f = await fixture(t)
  const established = await admittedUpgrade(f)
  const establishedBackend = f.upgrades[0].socket
  f.control.mode = "pending"
  const pending = rawClient(f, handshake())
  await waitFor(f.backend, "fixture-upgrade", () => f.upgrades.length === 2, "pending backend handshake")
  const pendingBackend = f.upgrades[1].socket
  const backendClosed = [establishedBackend, pendingBackend].map((socket) => bounded(once(socket, "close"), "backend tunnel close"))
  const clientClosed = [established.closed(), pending.closed()]
  const [, , responses] = await Promise.all([
    bounded(f.shutdown(), "explicit gateway shutdown"),
    Promise.all(backendClosed),
    Promise.all(clientClosed),
  ])
  for (const response of responses) assertNoSecrets(response.toString("latin1"))
  assert.equal(f.gateway.server.listening, false)
})
