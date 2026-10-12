// Tailscale Serve must strip client-supplied identity headers and inject its authenticated
// user. Loopback alone is not authentication: both HTTP assets and WebSocket upgrades
// require the configured owner. Only the backend /wire upgrade receives the private token.

import { createHash } from "node:crypto"
import { open, readFile } from "node:fs/promises"
import http from "node:http"
import { resolve } from "node:path"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"

export const LISTEN_HOST = "127.0.0.1"
export const LISTEN_PORT = 18377
export const LOCAL_WASM_PATH = "/pkg/stencil_tern_web_bg.wasm"
export const WIRE_PATH = "/wire"

const INDEX_PATHS = new Set(["/", "/index.html"])
const STATIC_PATHS = new Set([
  ...INDEX_PATHS,
  "/manifest.webmanifest",
  "/favicon.svg",
  "/favicon-32.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/pkg/stencil_tern_web.js",
  LOCAL_WASM_PATH,
])
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])
const MAX_BODY_BYTES = 16 * 1024 * 1024
const SHUTDOWN_GRACE_MS = 5_000
const REQUEST_HEADERS = ["accept", "accept-language", "if-none-match", "if-modified-since"]
const RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "last-modified"]
const UPGRADE_REQUEST_HEADERS = ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]
const UPGRADE_RESPONSE_HEADERS = { "sec-websocket-accept": "Sec-WebSocket-Accept", "sec-websocket-protocol": "Sec-WebSocket-Protocol", "sec-websocket-extensions": "Sec-WebSocket-Extensions" }
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "cross-origin-resource-policy": "same-origin",
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} must be configured`)
  }
  return value
}

export function normalizeOrigin(value) {
  let url
  try {
    if (typeof value !== "string" || !value) throw new Error()
    url = new URL(value)
  } catch {
    throw new Error("TERN_PUBLIC_ORIGIN must be an absolute http(s) origin")
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("TERN_PUBLIC_ORIGIN must be an absolute http(s) origin")
  }
  return url.origin
}

export function configFromEnv(env = process.env) {
  return {
    tokenFile: requiredString(env.TERN_TOKEN_FILE, "TERN_TOKEN_FILE"),
    wasmFile: requiredString(env.TERN_WASM_FILE, "TERN_WASM_FILE"),
    publicOrigin: normalizeOrigin(env.TERN_PUBLIC_ORIGIN),
    ownerLogin: requiredString(env.TERN_OWNER_LOGIN, "TERN_OWNER_LOGIN"),
  }
}

export async function readToken(file) {
  let token
  try {
    token = (await readFile(file, "utf8")).trim()
  } catch {
    throw new Error("private web token unavailable")
  }
  if (!/^[\x21-\x7e]+$/.test(token)) throw new Error("private web token unavailable")
  return token
}

// Origin-form paths only; queries never reach the backend. Dot segments, escapes,
// backslashes, absolute targets and empty segments are not static asset paths.
export function staticPath(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/")) return null
  const path = rawUrl.split("?", 1)[0]
  return /^\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*(?:[A-Za-z0-9_-][A-Za-z0-9._-]*)?$/.test(path) ? path : null
}

function headerCount(req, name) {
  let count = 0
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) count += 1
  }
  return count
}

function containsSecret(value, token) {
  return value.includes(token) || value.includes(encodeURIComponent(token))
}

function plain(res, status, extra = {}) {
  if (res.destroyed || res.headersSent) return
  const body = `${http.STATUS_CODES[status] ?? "Error"}\n`
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extra,
  })
  res.end(res.req.method === "HEAD" ? undefined : body)
}

function rawReject(socket, status) {
  if (socket.destroyed) return
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`)
  setTimeout(() => socket.destroy(), 1_000).unref()
}

export function createGateway(options = {}) {
  const {
    backendHost = "127.0.0.1",
    backendPort = 8377,
    backendTimeoutMs = 15_000,
    log = (message) => console.error(`tern-gateway: ${message}`),
  } = options
  const tokenFile = requiredString(options.tokenFile, "TERN_TOKEN_FILE")
  const wasmFile = requiredString(options.wasmFile, "TERN_WASM_FILE")
  const publicOrigin = normalizeOrigin(options.publicOrigin)
  const ownerLogin = requiredString(options.ownerLogin, "TERN_OWNER_LOGIN")
  const backendAuthority = `${backendHost}:${backendPort}`
  const tunnels = new Set()
  const pending = new Set()
  const connections = new Set()
  let closing = false
  let shutdownPromise
  let finishShutdown

  function authenticated(req, requireOrigin) {
    if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress)) return false
    if (headerCount(req, "tailscale-user-login") !== 1 || req.headers["tailscale-user-login"] !== ownerLogin) return false
    const origins = headerCount(req, "origin")
    return origins === 0 ? !requireOrigin : origins === 1 && req.headers.origin === publicOrigin
  }

  async function serveWasm(req, res) {
    let handle
    try {
      handle = await open(wasmFile, "r")
      const info = await handle.stat()
      if (!info.isFile()) throw new Error()
      if (res.destroyed) return
      const etag = `"${createHash("sha256").update(`${info.size}:${info.mtimeMs}:${info.ino}`).digest("hex").slice(0, 32)}"`
      const headers = { ...SECURITY_HEADERS, "content-type": "application/wasm", "cache-control": "no-cache", etag }
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, headers)
        return res.end()
      }
      res.writeHead(200, { ...headers, "content-length": info.size })
      if (req.method === "HEAD") return res.end()
      const stream = handle.createReadStream({ autoClose: true })
      handle = undefined
      await pipeline(stream, res)
    } catch {
      if (!res.headersSent) {
        log("local wasm unavailable")
        plain(res, 404)
      } else {
        res.destroy()
      }
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  async function forward(req, res, path) {
    let token
    try {
      token = await readToken(tokenFile)
    } catch {
      log("private web token unavailable; refusing static response")
      return plain(res, 503)
    }
    if (res.destroyed || closing) return plain(res, 503, { connection: "close" })
    const isIndex = INDEX_PATHS.has(path)
    const headers = { host: backendAuthority, "accept-encoding": "identity" }
    for (const name of REQUEST_HEADERS) {
      if (isIndex && name.startsWith("if-")) continue
      if (typeof req.headers[name] === "string") headers[name] = req.headers[name]
    }
    const upstream = http.request({
      host: backendHost,
      port: backendPort,
      method: isIndex ? "GET" : req.method,
      path,
      headers,
      agent: false,
      timeout: backendTimeoutMs,
    })
    let failed = false
    const fail = (status, message) => {
      if (failed) return
      failed = true
      if (message) log(message)
      if (!res.headersSent) plain(res, status)
      else res.destroy()
      upstream.destroy()
    }
    res.on("close", () => upstream.destroy())
    upstream.on("timeout", () => fail(504, "backend request timed out"))
    upstream.on("error", () => fail(502, "backend request failed"))
    upstream.on("response", (backend) => {
      const status = backend.statusCode
      const passHeaders = { ...SECURITY_HEADERS }
      for (const name of RESPONSE_HEADERS) {
        const value = backend.headers[name]
        if (typeof value !== "string") continue
        if (containsSecret(value, token)) {
          backend.resume()
          return fail(502, "blocked unsafe backend response")
        }
        passHeaders[name] = value
      }
      if (status === 304 && !isIndex) {
        backend.resume()
        res.writeHead(304, passHeaders)
        return res.end()
      }
      if (status === 404) {
        backend.resume()
        return fail(404)
      }
      if (status !== 200) {
        backend.resume()
        return fail(502, "backend response rejected")
      }
      if (req.method === "HEAD" && !isIndex) {
        backend.resume()
        const length = backend.headers["content-length"]
        if (typeof length === "string" && /^\d+$/.test(length) && !containsSecret(length, token)) passHeaders["content-length"] = length
        res.writeHead(200, passHeaders)
        return res.end()
      }
      const chunks = []
      let size = 0
      backend.on("data", (chunk) => {
        if (failed) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) return fail(502, "backend response too large")
        chunks.push(chunk)
      })
      backend.on("error", () => fail(502, "backend response failed"))
      backend.on("aborted", () => fail(502, "backend response interrupted"))
      backend.on("end", () => {
        if (failed || res.destroyed || res.headersSent) return
        const body = Buffer.concat(chunks, size)
        if (containsSecret(body, token)) return fail(502, "blocked unsafe backend response")
        // Preserve the genuine cached page and its SRI verbatim; it already points at
        // LOCAL_WASM_PATH. No release-specific HTML or diagnostic rewriting is needed.
        res.writeHead(200, { ...passHeaders, "content-length": body.length })
        res.end(req.method === "HEAD" ? undefined : body)
      })
    })
    upstream.end()
  }

  function handleRequest(req, res) {
    req.resume()
    if (!authenticated(req, false)) return plain(res, 403)
    if (closing) return plain(res, 503, { connection: "close" })
    if (req.method !== "GET" && req.method !== "HEAD") return plain(res, 405, { allow: "GET, HEAD" })
    const path = staticPath(req.url)
    if (path === null) return plain(res, 404)
    if (path === WIRE_PATH) return plain(res, 426, { upgrade: "websocket" })
    if (!STATIC_PATHS.has(path)) return plain(res, 404)
    if (path === LOCAL_WASM_PATH) return void serveWasm(req, res)
    void forward(req, res, path)
  }

  function tunnel(client, backend) {
    const pair = { client, backend, close: undefined }
    let done = false
    let ending = false
    let timer
    const destroyBoth = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      tunnels.delete(pair)
      client.destroy()
      backend.destroy()
      finishShutdown?.()
    }
    const endOther = (other) => () => {
      if (done) return
      if (ending) {
        if (client.destroyed && backend.destroyed) destroyBoth()
        return
      }
      ending = true
      if (other.destroyed) return destroyBoth()
      timer = setTimeout(destroyBoth, SHUTDOWN_GRACE_MS)
      timer.unref()
      other.end(destroyBoth)
    }
    pair.close = () => {
      if (done || ending) return
      ending = true
      timer = setTimeout(destroyBoth, SHUTDOWN_GRACE_MS)
      timer.unref()
      client.end()
      backend.end()
    }
    tunnels.add(pair)
    for (const socket of [client, backend]) {
      socket.setTimeout(0)
      socket.setNoDelay(true)
      socket.on("error", destroyBoth)
    }
    // WebSocket has no TCP half-close: flush the remaining bytes, then release both.
    for (const event of ["end", "close"]) {
      client.on(event, endOther(backend))
      backend.on(event, endOther(client))
    }
    client.pipe(backend, { end: false })
    backend.pipe(client, { end: false })
  }

  function handleUpgrade(req, socket, head) {
    socket.on("error", () => socket.destroy())
    if (!authenticated(req, true)) return rawReject(socket, 403)
    if (closing) return rawReject(socket, 503)
    if (req.method !== "GET") return rawReject(socket, 405)
    if (staticPath(req.url) !== WIRE_PATH) return rawReject(socket, 404)
    if (String(req.headers.upgrade).toLowerCase() !== "websocket") return rawReject(socket, 400)
    if (typeof req.headers["sec-websocket-key"] !== "string" || typeof req.headers["sec-websocket-version"] !== "string") return rawReject(socket, 400)
    pending.add(socket)
    socket.once("close", () => pending.delete(socket))
    readToken(tokenFile).then((token) => {
      if (socket.destroyed || closing) return socket.destroy()
      const headers = { host: backendAuthority, connection: "Upgrade", upgrade: "websocket", origin: publicOrigin }
      for (const name of UPGRADE_REQUEST_HEADERS) if (typeof req.headers[name] === "string") headers[name] = req.headers[name]
      const upstream = http.request({
        host: backendHost,
        port: backendPort,
        method: "GET",
        path: `${WIRE_PATH}?token=${encodeURIComponent(token)}`,
        headers,
        agent: false,
        timeout: backendTimeoutMs,
      })
      let upgraded = false
      let failed = false
      const abort = () => { if (!upgraded) upstream.destroy() }
      socket.once("close", abort)
      const fail = (message, status = 502) => {
        if (upgraded || failed) return
        failed = true
        log(message)
        upstream.destroy()
        rawReject(socket, status)
      }
      upstream.on("timeout", () => fail("backend WebSocket handshake timed out", 504))
      upstream.on("error", () => fail("backend WebSocket connection failed"))
      upstream.on("response", (backend) => {
        backend.resume()
        fail("backend WebSocket upgrade rejected")
      })
      upstream.on("upgrade", (backend, backendSocket, backendHead) => {
        if (failed || socket.destroyed || closing) {
          backendSocket.destroy()
          return socket.destroy()
        }
        const lines = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade"]
        for (const [name, label] of Object.entries(UPGRADE_RESPONSE_HEADERS)) {
          const value = backend.headers[name]
          if (typeof value !== "string") continue
          if (containsSecret(value, token)) {
            backendSocket.destroy()
            return fail("blocked unsafe backend WebSocket response")
          }
          lines.push(`${label}: ${value}`)
        }
        upgraded = true
        socket.off("close", abort)
        pending.delete(socket)
        socket.write(`${lines.join("\r\n")}\r\n\r\n`)
        if (backendHead.length) socket.write(backendHead)
        if (head.length) backendSocket.write(head)
        tunnel(socket, backendSocket)
      })
      upstream.end()
    }).catch(() => {
      log("private web token unavailable; refusing WebSocket upgrade")
      rawReject(socket, 503)
    })
  }

  const server = http.createServer(handleRequest)
  server.headersTimeout = 10_000
  server.requestTimeout = 30_000
  server.on("upgrade", handleUpgrade)
  server.on("connection", (socket) => {
    connections.add(socket)
    socket.once("close", () => {
      connections.delete(socket)
      finishShutdown?.()
    })
  })
  server.on("clientError", (_error, socket) => {
    if (socket.writable) rawReject(socket, 400)
    else socket.destroy()
  })

  function shutdown(graceMs = SHUTDOWN_GRACE_MS) {
    if (shutdownPromise) return shutdownPromise
    closing = true
    shutdownPromise = new Promise((resolveClosed) => {
      let listenerClosed = false
      const force = setTimeout(() => {
        server.closeAllConnections()
        for (const socket of connections) socket.destroy()
        for (const pair of tunnels) {
          pair.client.destroy()
          pair.backend.destroy()
        }
      }, graceMs)
      force.unref()
      finishShutdown = () => {
        if (!listenerClosed || connections.size || tunnels.size) return
        clearTimeout(force)
        finishShutdown = undefined
        resolveClosed()
      }
      server.close(() => {
        listenerClosed = true
        finishShutdown?.()
      })
      server.closeIdleConnections()
      for (const socket of pending) socket.destroy()
      for (const pair of tunnels) pair.close()
    })
    return shutdownPromise
  }

  return { server, shutdown, publicOrigin, tunnels }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let gateway
  try {
    gateway = createGateway(configFromEnv())
  } catch {
    console.error("tern-gateway: required configuration is missing or invalid")
    process.exit(1)
  }
  gateway.server.on("error", () => {
    console.error("tern-gateway: listener failed")
    process.exit(1)
  })
  gateway.server.listen(LISTEN_PORT, LISTEN_HOST, () => console.error("tern-gateway: listening on loopback"))
  const stop = () => gateway.shutdown().then(() => process.exit(0))
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
}
