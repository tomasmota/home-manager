// Deterministic production/destructive-operation guard for permission review.
// No model calls and no network: a deny here is final and cannot be loosened
// by Jev, the LLM fallback, thresholds or reviewer outages.
//
// It inspects executable text only: bash commands (plus local shell scripts
// they run, read best-effort and bounded), eval code, and command-like
// arguments of other tools and xd:// devices. write/edit content is ignored,
// and files passed to node/python and other interpreters are never read.
// Interactive shells expand the user's zsh aliases (`alias -- k=kubectl` lines
// home-manager renders into $ZDOTDIR/.zshrc; parsed once, cached by mtime), so
// a leading alias is analyzed both as written and expanded: `k --context prod
// delete ...` typed into a tmux/tern pane or run by `zsh -ic` is caught.
// Text typed into panes runs in an unknown directory: the agent's directory
// may mark it production but never non-production.
//
// Each infrastructure CLI call gets a target class:
//   prod     a target identifier (kube context/cluster/kubeconfig, helm kube
//            context, gcloud project, aws profile, az subscription, IaC
//            directory/var-file/workspace, DB URL/host, ssh host, bucket) or
//            any token of the analyzed text is a production word, or matches
//            an OMP_JEV_PROTECTED_TARGETS entry (comma-separated)
//   trusted  every kube context/cluster named exactly matches an
//            OMP_JEV_TRUSTED_TARGETS entry (comma-separated, no production
//            word): any call, destructive included, skips review
//   nonprod  an explicit identifier names a non-production environment
//   unknown  anything else, including implicit defaults
// Hard deny: non-read-only calls on prod; destructive calls on prod/unknown;
// force-push or deletion of protected branches; repository deletion.
// Other infrastructure mutations return "infra" so callers fail closed.

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

const words = (text) => new Set(text.trim().split(/\s+/))

const MAX_DEPTH = 10
const MAX_BUDGET = 2 * 1024 * 1024
const MAX_TEXT = 256 * 1024
const MAX_FILE_BYTES = 256 * 1024
const MAX_FILES = 32
const MAX_SHOWN = 160

// ---------------------------------------------------------------------------
// Target words

const PROD_TOKEN = /^(?:prod|production|prd)\d*$/
const NONPROD_TOKEN = /^(?:dev|devel|develop|development|test|testing|tst|qa|staging|stage|stg|sandbox|playground|local|localhost|kind|minikube|k3d|orbstack|colima|preview|ephemeral)\d*$/
const NONPROD_SEQUENCES = [["docker", "desktop"], ["rancher", "desktop"], ["127", "0", "0", "1"]]

function tokensOf(value) {
  return String(value).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

function hasSequence(tokens, sequence) {
  outer: for (let i = 0; i + sequence.length <= tokens.length; i++) {
    for (let j = 0; j < sequence.length; j++) if (tokens[i + j] !== sequence[j]) continue outer
    return true
  }
  return false
}

function prodToken(tokens, protectedTargets) {
  for (const token of tokens) if (PROD_TOKEN.test(token)) return `production token "${token}"`
  for (const sequence of protectedTargets) {
    if (hasSequence(tokens, sequence)) return `protected target "${sequence.join("-")}"`
  }
  return null
}

function nonProdToken(tokens) {
  for (const token of tokens) if (NONPROD_TOKEN.test(token)) return token
  return NONPROD_SEQUENCES.some((sequence) => hasSequence(tokens, sequence)) ? "local" : null
}

export function parseProtectedTargets(raw) {
  return String(raw || "").split(",").map(tokensOf).filter((sequence) => sequence.length > 0)
}

// Exact kube context/cluster names whose every call is trusted, including
// destructive ones. Production words and protected targets still win.
export function parseTrustedTargets(raw) {
  return new Set(String(raw || "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean))
}

function trustedTarget(inv, trustedTargets) {
  if (!trustedTargets.size) return null
  const kube = inv.ids.filter((item) => item.kind === "name" && /^kube (?:context|cluster)$/.test(item.label))
  if (!kube.length || !kube.every((item) => trustedTargets.has(item.value.toLowerCase()))) return null
  return `${kube[0].label} "${kube[0].value}"`
}

function isLocalHost(host) {
  return /^(?:localhost|127(?:\.\d{1,3}){3}|::1|\[::1\]|0\.0\.0\.0)$/i.test(host) || host.startsWith("/")
}

function urlHost(value) {
  try {
    const host = new URL(value).hostname
    if (host) return host
  } catch {}
  const match = /(?:^|[\s@])host=([^\s]+)|@([^/:?\s]+)/.exec(value)
  return match ? match[1] ?? match[2] : null
}

// ---------------------------------------------------------------------------
// Shell parsing: segments of words split on ; && || | & ( ) and newlines, with
// redirects, heredoc/here-string stdin and pipe links. Command substitutions
// are returned separately so they are analyzed too.

const ANSI_ESCAPES = { n: "\n", t: "\t", r: "\r", "'": "'", "\\": "\\", '"': '"' }

function newSegment(pipeFrom) {
  return { words: [], redirects: [], stdin: [], pipeFrom }
}

const EMPTY_SEGMENT = Object.freeze(newSegment(null))

function skipDouble(text, start) {
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") i++
    else if (text[i] === '"') return i
  }
  return text.length
}

function matchingParen(text, start) {
  let depth = 1
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === "\\") i++
    else if (c === "'") {
      const end = text.indexOf("'", i + 1)
      if (end < 0) return text.length
      i = end
    } else if (c === '"') i = skipDouble(text, i + 1)
    else if (c === "(") depth++
    else if (c === ")" && --depth === 0) return i
  }
  return text.length
}

function closingBacktick(text, start) {
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") i++
    else if (text[i] === "`") return i
  }
  return text.length
}

export function parseShell(text) {
  const segments = []
  const substitutions = []
  const heredocs = []
  const n = text.length
  let segment = newSegment(null)
  let word = null
  let redirect = null

  const append = (value, quoted = false) => {
    if (!word) word = { value: "", quoted: false }
    word.value += value
    if (quoted) word.quoted = true
  }
  const endWord = () => {
    if (!word) return
    const current = word
    word = null
    if (!redirect) {
      segment.words.push(current)
      return
    }
    const op = redirect
    redirect = null
    if (op === "<<" || op === "<<-") heredocs.push({ delimiter: current.value, strip: op === "<<-", segment })
    else if (op === "<<<") segment.stdin.push(current.value)
    else segment.redirects.push({ op, target: current.value })
  }
  const endSegment = (op) => {
    endWord()
    redirect = null
    segments.push(segment)
    segment = newSegment(op === "|" || op === "|&" ? segment : null)
  }
  const readDollar = (start, quoted) => {
    const next = text[start + 1]
    if (next === "(") {
      const end = matchingParen(text, start + 2)
      const inner = text.slice(start + 2, end)
      substitutions.push(inner.startsWith("(") && inner.endsWith(")") ? inner.slice(1, -1) : inner)
      append(`$(${inner})`, quoted)
      return end + 1
    }
    if (next === "{") {
      const end = text.indexOf("}", start + 2)
      const stop = end < 0 ? n : end
      append(text.slice(start, stop + 1), quoted)
      return stop + 1
    }
    if (next === "'" && !quoted) {
      let value = ""
      let k = start + 2
      while (k < n && text[k] !== "'") {
        if (text[k] === "\\" && k + 1 < n) {
          value += ANSI_ESCAPES[text[k + 1]] ?? text[k + 1]
          k += 2
        } else value += text[k++]
      }
      append(value, true)
      return k + 1
    }
    if (next === '"' && !quoted) return readDouble(start + 2)
    append("$", quoted)
    return start + 1
  }
  const readDouble = (start) => {
    append("", true)
    let k = start
    while (k < n && text[k] !== '"') {
      const c = text[k]
      if (c === "\\" && k + 1 < n) {
        const next = text[k + 1]
        if (next !== "\n") append('"\\$`'.includes(next) ? next : c + next, true)
        k += 2
      } else if (c === "$") k = readDollar(k, true)
      else if (c === "`") {
        const end = closingBacktick(text, k + 1)
        const inner = text.slice(k + 1, end)
        substitutions.push(inner)
        append(inner, true)
        k = end + 1
      } else {
        append(c, true)
        k++
      }
    }
    return k + 1
  }
  const readHeredocs = (start) => {
    let k = start
    while (heredocs.length) {
      const doc = heredocs.shift()
      const lines = []
      while (k < n) {
        const end = text.indexOf("\n", k)
        const stop = end < 0 ? n : end
        const line = text.slice(k, stop)
        k = stop + 1
        if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delimiter) break
        lines.push(line)
      }
      doc.segment.stdin.push(lines.join("\n"))
    }
    return Math.min(k, n)
  }

  let i = 0
  while (i < n) {
    const c = text[i]
    if (c === "\\") {
      if (text[i + 1] !== "\n") append(text[i + 1] ?? "", true)
      i += 2
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1)
      const stop = end < 0 ? n : end
      append(text.slice(i + 1, stop), true)
      i = stop + 1
    } else if (c === '"') i = readDouble(i + 1)
    else if (c === "`") {
      const end = closingBacktick(text, i + 1)
      const inner = text.slice(i + 1, end)
      substitutions.push(inner)
      append(inner)
      i = end + 1
    } else if (c === "$") i = readDollar(i, false)
    else if (c === "#" && !word) {
      const end = text.indexOf("\n", i)
      i = end < 0 ? n : end
    } else if (c === "\n") {
      endSegment("\n")
      i = heredocs.length ? readHeredocs(i + 1) : i + 1
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord()
      i++
    } else if (c === ";") {
      const op = text.startsWith(";;&", i) ? ";;&" : text.startsWith(";;", i) ? ";;" : text.startsWith(";&", i) ? ";&" : ";"
      endSegment(op)
      i += op.length
    } else if (c === "&") {
      if (text[i + 1] === "&") {
        endSegment("&&")
        i += 2
      } else if (text[i + 1] === ">") {
        endWord()
        redirect = text[i + 2] === ">" ? "&>>" : "&>"
        i += redirect.length
      } else {
        endSegment("&")
        i++
      }
    } else if (c === "|") {
      const op = text[i + 1] === "|" ? "||" : text[i + 1] === "&" ? "|&" : "|"
      endSegment(op)
      i += op.length
    } else if (c === "(" || c === ")") {
      endSegment(c)
      i++
    } else if (c === "<" || c === ">") {
      if (text[i + 1] === "(") {
        const end = matchingParen(text, i + 2)
        const inner = text.slice(i + 2, end)
        substitutions.push(inner)
        append(`${c}(${inner})`)
        i = end + 1
        continue
      }
      if (word && !word.quoted && /^\d+$/.test(word.value)) word = null
      else endWord()
      redirect = /^(?:<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/.exec(text.slice(i, i + 3))[0]
      i += redirect.length
    } else {
      append(c)
      i++
    }
  }
  endSegment(null)
  return {
    segments: segments.filter((item) => item.words.length || item.stdin.length || item.redirects.length),
    substitutions,
  }
}

// ---------------------------------------------------------------------------
// Argument helpers

function parseArgs(args, valueFlags, { singleDashLong = false, attachedOnly } = {}) {
  const positionals = []
  const flags = new Map()
  let rest = []
  const add = (name, value) => {
    const list = flags.get(name)
    if (list) list.push(value)
    else flags.set(name, [value])
  }
  for (let k = 0; k < args.length; k++) {
    const arg = args[k]
    if (arg === "--") {
      rest = args.slice(k + 1)
      break
    }
    if (arg.length < 2 || arg[0] !== "-" || /^-\d/.test(arg)) {
      positionals.push(arg)
      continue
    }
    if (arg.startsWith("--") || singleDashLong) {
      const body = arg.replace(/^--?/, "")
      const eq = body.indexOf("=")
      const name = `--${eq >= 0 ? body.slice(0, eq) : body}`
      if (eq >= 0) add(name, body.slice(eq + 1))
      else if (valueFlags.has(name) && k + 1 < args.length) add(name, args[++k])
      else add(name, true)
      continue
    }
    for (let c = 1; c < arg.length; c++) {
      const name = `-${arg[c]}`
      if (attachedOnly?.has(name)) {
        add(name, arg.slice(c + 1) || true)
        break
      }
      if (valueFlags.has(name)) {
        const attached = arg.slice(c + 1).replace(/^=/, "")
        if (attached) add(name, attached)
        else if (k + 1 < args.length) add(name, args[++k])
        else add(name, true)
        break
      }
      add(name, true)
    }
  }
  return { positionals, flags, rest }
}

function has(flags, ...names) {
  return names.some((name) => flags.has(name))
}

function values(flags, ...names) {
  return names.flatMap((name) => (flags.get(name) ?? []).filter((value) => typeof value === "string"))
}

function dryRun(flags) {
  return (flags.get("--dry-run") ?? []).some((value) => value === true || /^(?:client|server|true)$/i.test(value))
}

function id(label, value, kind = "name") {
  return { label, value: String(value), kind }
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

function setAssignment(map, word) {
  const eq = word.indexOf("=")
  map.set(word.slice(0, eq), word.slice(eq + 1))
}

function expandVariables(value, vars) {
  if (!vars.size || !value.includes("$")) return value
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, plain) => {
    const name = braced ?? plain
    return vars.has(name) ? vars.get(name) : match
  })
}

function commandName(word) {
  if (!word) return ""
  let value = word.replace(/^\\/, "")
  const hash = value.lastIndexOf("#")
  if (hash >= 0) value = value.slice(hash + 1)
  return basename(value).toLowerCase()
}

function shown(argv) {
  const text = argv.join(" ").replace(/\s+/g, " ").trim()
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN - 3)}...` : text
}

function envValue(env, ctx, name) {
  return env.get(name) ?? ctx.vars.get(name)
}

function explicitEnvIds(env, ctx, spec) {
  return spec.flatMap(([name, label, kind]) => {
    const value = envValue(env, ctx, name)
    return value ? [id(label, value, kind)] : []
  })
}

function processEnvIds(ctx, spec) {
  if (ctx.remote) return []
  return spec.flatMap(([name, label, kind]) => {
    const value = ctx.state.env[name]
    return value ? [id(label, value, kind)] : []
  })
}

// ---------------------------------------------------------------------------
// Filesystem (best effort, bounded)

function resolvePath(path, ctx) {
  if (typeof path !== "string" || !path) return undefined
  const home = ctx.state.env.HOME
  let value = path
  if (home && (value === "~" || value.startsWith("~/"))) value = join(home, value.slice(2))
  if (isAbsolute(value)) return resolve(value)
  return ctx.dir ? resolve(ctx.dir, value) : value
}

// Inside text typed into a pane, relative directories hang off an unknown cwd.
function guessedDir(chdir, ctx) {
  return Boolean(ctx.dirGuess) && !(chdir && (isAbsolute(chdir) || chdir.startsWith("~")))
}

function readFileText(path, limit) {
  let fd
  try {
    const info = statSync(path)
    if (!info.isFile()) return null
    fd = openSync(path, "r")
    const buffer = Buffer.alloc(Math.min(info.size, limit))
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, length).toString("utf8")
    return text.includes("\0") ? null : text
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

function readBounded(path, state) {
  if (!path || !isAbsolute(path)) return null
  if (state.virtualFiles.has(path)) return state.virtualFiles.get(path)
  if (state.files >= MAX_FILES) return null
  state.files++
  return readFileText(path, MAX_FILE_BYTES)
}

const MAX_RC_BYTES = 1024 * 1024
const MAX_ALIASES = 1024
const aliasCache = new Map()

// The rendered rc file, not shell/aliases.nix: it is exactly what interactive
// zsh loads, with Nix interpolation and quoting already resolved.
function zshrc(env) {
  const candidates = [
    env.ZDOTDIR && join(env.ZDOTDIR, ".zshrc"),
    env.HOME && join(env.HOME, ".config", "zsh", ".zshrc"),
    env.HOME && join(env.HOME, ".zshrc"),
  ]
  for (const path of candidates) {
    if (!path) continue
    try {
      const info = statSync(path)
      if (info.isFile()) return { path, key: `${info.mtimeMs}:${info.size}` }
    } catch {}
  }
  return null
}

// `alias [-g] [--] name=value ...` statements, values unquoted by shell rules.
// Suffix aliases (-s) never expand in command position and are skipped.
export function parseAliases(text) {
  const aliases = new Map()
  for (const match of text.matchAll(/^[ \t]*alias[ \t]+/gm)) {
    const statement = parseShell(text.slice(match.index, match.index + 4096)).segments[0]
    const argv = statement?.words.map((item) => item.value) ?? []
    let k = 1
    let suffix = false
    while (k < argv.length && /^[-+]/.test(argv[k])) {
      const flag = argv[k++]
      if (flag === "--") break
      if (flag.includes("s")) suffix = true
    }
    if (suffix) continue
    for (const word of argv.slice(k)) {
      const eq = word.indexOf("=")
      if (eq > 0) aliases.set(word.slice(0, eq), word.slice(eq + 1))
    }
    if (aliases.size >= MAX_ALIASES) break
  }
  return aliases
}

function loadAliases(env) {
  const rc = zshrc(env)
  if (!rc) return new Map()
  const cached = aliasCache.get(rc.path)
  if (cached?.key === rc.key) return cached.aliases
  const text = readFileText(rc.path, MAX_RC_BYTES)
  const aliases = text ? parseAliases(text) : new Map()
  aliasCache.set(rc.path, { key: rc.key, aliases })
  return aliases
}

function shellQuote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`
}

function repoRoot(path, ctx) {
  if (ctx.remote || !path || !isAbsolute(path)) return null
  const cache = ctx.state.repoRoots
  if (cache.has(path)) return cache.get(path)
  let current = path
  let root = null
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(current, ".git"))) {
      root = current
      break
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  cache.set(path, root)
  return root
}

function currentBranch(dir, ctx) {
  const root = repoRoot(dir, ctx)
  if (!root) return null
  let gitDir = join(root, ".git")
  const pointer = readBounded(gitDir, ctx.state)
  if (pointer) {
    const match = /^gitdir:\s*(.+)$/m.exec(pointer)
    if (!match) return null
    gitDir = resolve(root, match[1].trim())
  }
  const head = readBounded(join(gitDir, "HEAD"), ctx.state)
  const match = head && /^ref:\s*refs\/heads\/(.+)$/.exec(head.trim())
  return match ? match[1] : null
}

function kubeconfigIds(flags, env, ctx) {
  const files = values(flags, "--kubeconfig")
  const fromEnv = envValue(env, ctx, "KUBECONFIG")
  if (fromEnv) files.push(...fromEnv.split(":").filter(Boolean))
  return files.map((file) => id("kubeconfig", file, "file"))
}

// Implicit kube context: only ever upgrades a call to prod, never to nonprod.
function kubeImplicit(ctx, kubeconfigs) {
  if (ctx.remote) return []
  const ids = []
  let files = kubeconfigs.map((item) => item.value)
  if (!files.length) {
    const fromProcess = ctx.state.env.KUBECONFIG
    if (fromProcess) {
      files = fromProcess.split(":").filter(Boolean)
      ids.push(...files.map((file) => id("KUBECONFIG", file, "file")))
    } else if (ctx.state.env.HOME) files = [join(ctx.state.env.HOME, ".kube", "config")]
  }
  for (const file of files.slice(0, 4)) {
    const text = readBounded(resolvePath(file, ctx), ctx.state)
    const match = text && /^current-context:\s*["']?([^"'\s#]+)/m.exec(text)
    if (match) {
      ids.push(id("current kube context", match[1]))
      break
    }
  }
  return ids
}

function gcloudImplicit(ctx, env) {
  if (ctx.remote) return []
  const base = ctx.state.env.CLOUDSDK_CONFIG || (ctx.state.env.HOME ? join(ctx.state.env.HOME, ".config", "gcloud") : null)
  if (!base) return []
  const active = envValue(env, ctx, "CLOUDSDK_ACTIVE_CONFIG_NAME") || ctx.state.env.CLOUDSDK_ACTIVE_CONFIG_NAME ||
    readBounded(join(base, "active_config"), ctx.state)?.trim() || "default"
  const text = readBounded(join(base, "configurations", `config_${active}`), ctx.state)
  const match = text && /^\s*project\s*=\s*(\S+)/m.exec(text)
  return [
    ...(active !== "default" ? [id("active gcloud configuration", active)] : []),
    ...(match ? [id("active gcloud project", match[1])] : []),
  ]
}

function azureImplicit(ctx) {
  if (ctx.remote) return []
  const base = ctx.state.env.AZURE_CONFIG_DIR || (ctx.state.env.HOME ? join(ctx.state.env.HOME, ".azure") : null)
  const text = base && readBounded(join(base, "azureProfile.json"), ctx.state)
  if (!text) return []
  try {
    const profile = JSON.parse(text.replace(/^\uFEFF/, ""))
    const current = profile?.subscriptions?.find?.((item) => item?.isDefault)
    return current?.name ? [id("default az subscription", current.name)] : []
  } catch {
    return []
  }
}

function dockerImplicit(ctx) {
  if (ctx.remote) return []
  const ids = processEnvIds(ctx, [["DOCKER_HOST", "DOCKER_HOST", "url"], ["DOCKER_CONTEXT", "DOCKER_CONTEXT"]])
  const base = ctx.state.env.DOCKER_CONFIG || (ctx.state.env.HOME ? join(ctx.state.env.HOME, ".docker") : null)
  const text = base && readBounded(join(base, "config.json"), ctx.state)
  try {
    const current = text && JSON.parse(text).currentContext
    if (typeof current === "string" && current !== "default") ids.push(id("current docker context", current))
  } catch {}
  return ids
}

// ---------------------------------------------------------------------------
// Verdicts

function deny(ctx, reasonCode, what) {
  if (ctx.state.deny) return
  ctx.state.deny = {
    reasonCode,
    message: `Blocked by the deterministic production guard: ${what}. Do not retry, rephrase, split, or otherwise work around this block (scripts, eval, ssh, tmux or other tools). If this operation is really needed, ask the user to run it themselves.`,
  }
}

function noteInfra(ctx, note) {
  if (ctx.state.infra.length < 4) ctx.state.infra.push(note)
}

function nonProdId(identifier, ctx) {
  if (identifier.guess) return false
  switch (identifier.kind) {
    case "dir": {
      const root = repoRoot(identifier.value, ctx)
      return root ? Boolean(nonProdToken(tokensOf(relative(root, identifier.value)))) : false
    }
    case "file":
      return Boolean(nonProdToken(tokensOf(basename(identifier.value))))
    case "host":
      if (isLocalHost(identifier.value)) return !ctx.remote
      return Boolean(nonProdToken(tokensOf(identifier.value)))
    case "url": {
      const host = urlHost(identifier.value)
      if (host && isLocalHost(host)) return !ctx.remote
      return Boolean(nonProdToken(tokensOf(identifier.value)))
    }
    default:
      return Boolean(nonProdToken(tokensOf(identifier.value)))
  }
}

function describeIds(ids) {
  return ids.slice(0, 2).map((item) => `${item.label} "${item.value}"`).join(", ")
}

function classifyTarget(inv, ctx) {
  const { protectedTargets } = ctx.state
  for (const item of [...inv.ids, ...(inv.implicit ?? [])]) {
    const hit = prodToken(tokensOf(item.value), protectedTargets)
    if (hit) return { cls: "prod", evidence: `${item.label} "${item.value}"${hit.startsWith("protected") ? ` matches ${hit}` : ""}` }
  }
  if (ctx.taint) return { cls: "prod", evidence: ctx.taint }
  if (ctx.remote?.cls === "prod") return { cls: "prod", evidence: `runs on ${ctx.remote.label}` }
  const trusted = trustedTarget(inv, ctx.state.trustedTargets)
  if (trusted) return { cls: "trusted", evidence: trusted }
  const named = inv.ids.find((item) => nonProdId(item, ctx))
  if (named) return { cls: "nonprod", evidence: `${named.label} "${named.value}"` }
  // A command run inside a trusted target inherits it, unless it names a target of its own.
  if (ctx.remote && !(ctx.remote.cls === "trusted" && inv.ids.length)) return { cls: ctx.remote.cls, evidence: `runs on ${ctx.remote.label}` }
  if (inv.local) return { cls: "nonprod", evidence: inv.local }
  if (inv.ids.length) {
    return { cls: "unknown", evidence: `${describeIds(inv.ids)} ${inv.ids.length > 1 ? "are" : "is"} not an explicitly non-production target` }
  }
  return { cls: "unknown", evidence: `no explicit target; ${inv.implicitNote ?? "it would use an implicit default"}` }
}

function judge(inv, segment, ctx) {
  if (!inv || ctx.state.deny) return
  const target = classifyTarget(inv, ctx)
  if (target.cls === "trusted") {
    if (ctx.state.trusted.length < 4) ctx.state.trusted.push(`${shown(inv.argv)} [trusted target: ${target.evidence}]`)
  } else if (!inv.readOnly) {
    const display = `\`${shown(inv.argv)}\``
    if (target.cls === "prod") {
      return deny(ctx, "prod_mutation", `${display} is not a read-only operation and targets production (${target.evidence})`)
    }
    if (inv.destructive && target.cls === "unknown") {
      const kind = typeof inv.destructive === "string" ? inv.destructive : "a destructive operation"
      return deny(ctx, "unscoped_destructive", `${display} is ${kind} and its target is not an explicitly named non-production environment (${target.evidence})`)
    }
    // A local file (e.g. SQLite) is not shared infrastructure.
    if (!(inv.local && target.evidence === inv.local)) {
      noteInfra(ctx, `${shown(inv.argv)} [${target.cls === "nonprod" ? "non-production" : "unverified"} target: ${target.evidence}]`)
    }
  }
  for (const nested of inv.nested ?? []) {
    const child = {
      ...ctx,
      dir: undefined,
      vars: new Map(),
      remote: { cls: target.cls, label: `${nested.label} (${target.evidence})` },
    }
    if (nested.argv) analyzeArgv(nested.argv, nested.segment ?? EMPTY_SEGMENT, child, new Map())
    if (nested.text) analyzeText(nested.text, child)
  }
}

// ---------------------------------------------------------------------------
// Kubernetes

const KUBE_VALUES = words(`--context --cluster --kubeconfig --user -n --namespace -s --server --token --as --as-group
  --as-uid --certificate-authority --client-certificate --client-key --request-timeout --cache-dir -v --v
  --tls-server-name --profile --profile-output --log-file -f --filename -l --selector -o --output -c --container
  --field-selector -k --kustomize --replicas --for --timeout --since --since-time --tail --grace-period --type -p
  --patch --image --sort-by --template -L --label-columns --field-manager --subresource --chunk-size --to-revision
  --current-replicas --resource-version --overrides --env -e --target`)
const KUBE_READ = words(`get describe logs log top explain api-resources api-versions version cluster-info diff events
  wait completion kustomize options help whoami status projects`)
const KUBE_SUBREAD = {
  config: words("view get-contexts current-context get-clusters get-users"),
  auth: words("can-i whoami"),
  rollout: words("status history"),
  apply: words("view-last-applied"),
  plugin: words("list"),
  alpha: words("events"),
}
const KUBE_DESTRUCTIVE = words("delete drain cordon taint")
const KUBE_KNOWN = new Set([...KUBE_READ, ...KUBE_DESTRUCTIVE, ...words(`create apply edit patch replace scale autoscale
  rollout set label annotate expose run exec attach cp port-forward proxy debug uncordon certificate auth config plugin
  alpha login logout project`)])
const KUBE_CONTEXT_SWITCH = words("use-context use set-context delete-context rename-context set-cluster delete-cluster")

function kubectl(argv, segment, ctx, env) {
  const { positionals, flags, rest } = parseArgs(argv.slice(1), KUBE_VALUES)
  const [sub = "", sub2 = ""] = positionals
  let readOnly = !sub || has(flags, "--help", "-h") ||
    (Object.hasOwn(KUBE_SUBREAD, sub) ? KUBE_SUBREAD[sub].has(sub2) : KUBE_READ.has(sub))
  if (dryRun(flags)) readOnly = true
  const destructive = !readOnly && (
    KUBE_DESTRUCTIVE.has(sub) ||
    (sub === "scale" && values(flags, "--replicas").some((value) => Number(value) === 0)) ||
    (sub === "replace" && has(flags, "--force")) ||
    (sub === "apply" && has(flags, "--prune")) ||
    (!KUBE_KNOWN.has(sub) && positionals.some((item) => KUBE_DESTRUCTIVE.has(item)))
  )
  const ids = [
    ...values(flags, "--context").map((value) => id("kube context", value)),
    ...values(flags, "--cluster").map((value) => id("kube cluster", value)),
    ...values(flags, "--server", "-s").map((value) => id("API server", value, "url")),
  ]
  if (sub === "config" && KUBE_CONTEXT_SWITCH.has(sub2) && positionals[2]) ids.push(id("kube context", positionals[2]))
  const scoped = ids.length > 0
  const kubeconfigs = kubeconfigIds(flags, env, ctx)
  ids.push(...kubeconfigs)
  return {
    argv,
    readOnly,
    destructive,
    ids,
    implicit: scoped ? [] : kubeImplicit(ctx, kubeconfigs),
    implicitNote: "kubectl would use the current kubeconfig context",
    nested: (sub === "exec" || sub === "debug") && rest.length ? [{ argv: rest, label: "a pod" }] : [],
  }
}

const HELM_VALUES = words(`--kube-context --kubeconfig -n --namespace --kube-apiserver --kube-token --kube-as-user
  --kube-as-group --kube-ca-file --kube-tls-server-name --registry-config --repository-cache --repository-config
  --burst-limit --qps -f --values --set --set-string --set-file --set-json --set-literal --version --repo --timeout -o
  --output --revision --description --post-renderer --post-renderer-args --max --username --password --ca-file
  --cert-file --key-file --keyring -l --selector --history-max`)
const HELM_READ = words(`list ls status get history hist show inspect template lint search diff version env verify
  completion help repo dependency dep dependencies pull fetch package create plugin registry`)
const HELM_DESTRUCTIVE = words("uninstall delete del un rollback")
const HELM_KNOWN = new Set([...HELM_READ, ...HELM_DESTRUCTIVE, ...words("install upgrade test push")])

function helm(argv, segment, ctx, env) {
  const { positionals, flags } = parseArgs(argv.slice(1), HELM_VALUES)
  const [sub = ""] = positionals
  const readOnly = !sub || dryRun(flags) || has(flags, "--help", "-h") || HELM_READ.has(sub)
  const destructive = !readOnly && (
    HELM_DESTRUCTIVE.has(sub) ||
    (sub === "upgrade" && has(flags, "--force")) ||
    (!HELM_KNOWN.has(sub) && positionals.some((item) => HELM_DESTRUCTIVE.has(item)))
  )
  const ids = [
    ...values(flags, "--kube-context").map((value) => id("kube context", value)),
    ...values(flags, "--kube-apiserver").map((value) => id("API server", value, "url")),
    ...explicitEnvIds(env, ctx, [["HELM_KUBECONTEXT", "HELM_KUBECONTEXT"]]),
  ]
  const scoped = ids.length > 0
  const kubeconfigs = kubeconfigIds(flags, env, ctx)
  ids.push(...kubeconfigs)
  return {
    argv,
    readOnly,
    destructive,
    ids,
    implicit: scoped ? [] : [...processEnvIds(ctx, [["HELM_KUBECONTEXT", "HELM_KUBECONTEXT"]]), ...kubeImplicit(ctx, kubeconfigs)],
    implicitNote: "helm would use the current kubeconfig context",
  }
}

const HELMFILE_VALUES = words(`-e --environment -f --file --kube-context -n --namespace -l --selector --state-values-file
  --state-values-set --helm-binary --log-level --chart`)
const HELMFILE_READ = words("list lint template diff build deps repos status show-dag version write-values fetch cache init help")

function helmfile(argv, segment, ctx, env) {
  const { positionals, flags } = parseArgs(argv.slice(1), HELMFILE_VALUES)
  const [sub = ""] = positionals
  const readOnly = !sub || has(flags, "--help", "-h") || HELMFILE_READ.has(sub)
  const ids = [
    ...values(flags, "-e", "--environment").map((value) => id("helmfile environment", value)),
    ...values(flags, "--kube-context").map((value) => id("kube context", value)),
    ...explicitEnvIds(env, ctx, [["HELMFILE_ENVIRONMENT", "helmfile environment"]]),
  ]
  const scoped = ids.length > 0
  const kubeconfigs = kubeconfigIds(new Map(), env, ctx)
  ids.push(...kubeconfigs)
  return {
    argv,
    readOnly,
    destructive: !readOnly && (sub === "destroy" || sub === "delete"),
    ids,
    implicit: scoped ? [] : kubeImplicit(ctx, kubeconfigs),
    implicitNote: "helmfile would use the default environment and current kube context",
  }
}

// ---------------------------------------------------------------------------
// Infrastructure as code

const IAC_VALUES = words(`--chdir --var-file --var --state --state-out --backup --backend-config --out --target --replace
  --lock-timeout --parallelism --plugin-dir --from-module --terragrunt-working-dir --working-dir --terragrunt-config
  --config --terragrunt-source --source --terragrunt-iam-role --iam-assume-role --terragrunt-log-level --log-level
  --terragrunt-parallelism --queue-include-dir --queue-exclude-dir --terragrunt-include-dir --terragrunt-exclude-dir
  --filter --terragrunt-download-dir --download-dir --test-directory --generate-config-out --tf-path
  --terragrunt-tfpath`)
const IAC_READ = words(`plan show validate fmt output providers graph init version console get login logout metadata
  modules help hclfmt render-json render graph-dependencies dag output-module-groups validate-inputs terragrunt-info
  info find list catalog scaffold hcl`)
const IAC_SUB = {
  state: { read: words("list show pull"), destructive: words("rm mv push replace-provider") },
  workspace: { read: words("list show select"), destructive: words("delete") },
  stack: { read: words("generate output clean"), destructive: new Set() },
}
const IAC_DESTRUCTIVE = words("destroy force-unlock taint")
const IAC_KNOWN = new Set([...IAC_READ, ...IAC_DESTRUCTIVE, ...words("apply import refresh test untaint state workspace stack")])
const IAC_PASSTHROUGH = words("run-all run")

function pipedYes(segment) {
  const from = segment.pipeFrom
  if (!from) return false
  const [first, ...args] = from.words.map((item) => item.value)
  const name = commandName(first)
  return name === "yes" || ((name === "echo" || name === "printf") && args.some((arg) => /^y(?:es)?\b/i.test(arg)))
}

function iac(argv, segment, ctx, env) {
  const parsed = parseArgs(argv.slice(1), IAC_VALUES, { singleDashLong: true })
  let flags = parsed.flags
  let positionals = parsed.positionals.slice()
  let all = positionals[0] === "run-all" || has(flags, "--all")
  while (IAC_PASSTHROUGH.has(positionals[0])) positionals.shift()
  if (!positionals.length && parsed.rest.length) {
    const inner = parseArgs(parsed.rest, IAC_VALUES, { singleDashLong: true })
    positionals = inner.positionals
    flags = new Map([...flags, ...inner.flags])
  }
  let [sub = "", sub2 = ""] = positionals
  if (sub.endsWith("-all")) {
    sub = sub.slice(0, -4)
    all = true
  }
  const nested = Object.hasOwn(IAC_SUB, sub) ? IAC_SUB[sub] : null
  let readOnly = !sub || has(flags, "--help", "-h", "--version") || (nested ? !sub2 || nested.read.has(sub2) : IAC_READ.has(sub))
  if (sub === "init" && has(flags, "--migrate-state", "--force-copy")) readOnly = false
  if (sub === "workspace" && sub2 === "select" && has(flags, "--or-create")) readOnly = false
  let destructive = false
  if (!readOnly) {
    const cliArgs = ["TF_CLI_ARGS", "TF_CLI_ARGS_apply"].map((name) => envValue(env, ctx, name) ?? ctx.state.env[name] ?? "").join(" ")
    const autoApprove = sub === "apply" && (
      has(flags, "--auto-approve") ||
      (all && has(flags, "--terragrunt-non-interactive", "--non-interactive")) ||
      positionals.length > 1 ||
      pipedYes(segment) ||
      /auto-approve/.test(cliArgs)
    )
    destructive = IAC_DESTRUCTIVE.has(sub) || Boolean(nested?.destructive.has(sub2)) ||
      (sub === "apply" && has(flags, "--destroy", "--replace")) ||
      (!IAC_KNOWN.has(sub) && positionals.includes("destroy"))
    if (!destructive && autoApprove) destructive = "an apply without interactive plan approval"
  }
  const chdir = values(flags, "--chdir", "--terragrunt-working-dir", "--working-dir")[0] ?? envValue(env, ctx, "TG_WORKING_DIR")
  const workdir = chdir ? resolvePath(chdir, ctx) : ctx.dir
  const ids = []
  if (workdir) ids.push({ ...id(chdir ? "working directory" : "project directory", workdir, "dir"), guess: guessedDir(chdir, ctx) })
  for (const value of values(flags, "--var-file")) ids.push(id("var file", value, "file"))
  for (const value of values(flags, "--backend-config")) ids.push(id("backend config", value, value.includes("=") ? "name" : "file"))
  for (const value of values(flags, "--state")) ids.push(id("state file", value, "file"))
  ids.push(...explicitEnvIds(env, ctx, [["TF_WORKSPACE", "TF_WORKSPACE"]]))
  if (sub === "workspace" && positionals[2]) ids.push(id("workspace", positionals[2]))
  const implicit = processEnvIds(ctx, [["TF_WORKSPACE", "TF_WORKSPACE"]])
  if (!ctx.remote && workdir && isAbsolute(workdir)) {
    const selected = readBounded(join(workdir, ".terraform", "environment"), ctx.state)?.trim()
    if (selected && selected !== "default") implicit.push(id("selected workspace", selected))
  }
  return { argv, readOnly, destructive, ids, implicit }
}

const TERRAMATE_VALUES = words(`-C --chdir --tags --no-tags -B --git-change-base --parallel -j --log-level --log-fmt
  --log-destination --target --from-target --terraform-plan-file --tofu-plan-file --cloud-sync-terraform-plan-file
  --status --cloud-status`)
const TERRAMATE_READ = words(`list fmt generate create version install-completions debug experimental help metadata
  globals partial-eval get-config-value trigger vendor cloud`)

function terramate(argv, segment, ctx, env) {
  const { positionals, flags, rest } = parseArgs(argv.slice(1), TERRAMATE_VALUES)
  const [sub = ""] = positionals
  const chdir = values(flags, "-C", "--chdir")[0]
  const dir = chdir ? resolvePath(chdir, ctx) : ctx.dir
  if (sub === "run") {
    let inner = rest
    if (!inner.length) {
      let k = argv.indexOf("run") + 1
      while (k < argv.length && argv[k].startsWith("-")) k += TERRAMATE_VALUES.has(argv[k]) ? 2 : 1
      inner = argv.slice(k)
    }
    if (inner.length) analyzeArgv(inner, segment, { ...ctx, dir }, new Map(env))
    return undefined
  }
  return {
    argv,
    readOnly: !sub || has(flags, "--help", "-h") || TERRAMATE_READ.has(sub),
    destructive: false,
    ids: dir ? [{ ...id(chdir ? "working directory" : "project directory", dir, "dir"), guess: guessedDir(chdir, ctx) }] : [],
  }
}

// ---------------------------------------------------------------------------
// Cloud CLIs

// Object-store transfer verbs shared by gcloud storage, gsutil and aws s3.
function transfer(op, paths, scheme, deleteFlag) {
  const dest = paths.at(-1) ?? ""
  const sources = paths.slice(0, -1)
  switch (op) {
    case "ls": case "cat": case "du": case "hash": case "stat": case "presign": case "signurl":
      return { readOnly: true, destructive: false }
    case "rm": case "rb":
      return { readOnly: false, destructive: true }
    case "mv":
      return { readOnly: false, destructive: sources.some((item) => item.startsWith(scheme)) }
    case "cp": case "rsync": case "sync": {
      const upload = dest.startsWith(scheme)
      return { readOnly: !upload, destructive: upload && deleteFlag }
    }
    default:
      return null
  }
}

function bucketIds(items, scheme) {
  return items.filter((item) => item.startsWith(scheme)).map((item) => id("bucket", item))
}

const GCLOUD_VALUES = words(`--project --account --configuration --impersonate-service-account --billing-project --format
  --filter --flags-file --verbosity --region --zone --limit --page-size --sort-by --trace-token --location --command
  --ssh-flag --member --role`)
const GCLOUD_RELEASE = words("alpha beta preview")
const GCLOUD_READ = words(`list describe ls cat du read tail info version help topic get-value get-credentials
  get-iam-policy get-server-config get-ancestors get-ancestors-iam-policy search-all-resources search-all-iam-policies
  analyze-iam-policy test-iam-permissions print-access-token print-identity-token print-settings hash`)
const GCLOUD_DESTRUCTIVE = words("delete rm rb reset set-iam-policy remove-iam-policy-binding restore-backup")
const GCLOUD_ENV = [
  ["CLOUDSDK_CORE_PROJECT", "gcloud project"],
  ["GOOGLE_CLOUD_PROJECT", "gcloud project"],
  ["CLOUDSDK_ACTIVE_CONFIG_NAME", "gcloud configuration"],
  ["CLOUDSDK_CORE_ACCOUNT", "gcloud account"],
]

function gcloudRead(item) {
  return GCLOUD_READ.has(item) || /^(?:list|describe|get|print|search|test|analyze)-/.test(item)
}

function gcloudDestructive(item, path) {
  return GCLOUD_DESTRUCTIVE.has(item) || /^delete-/.test(item) || (item === "disable" && path.includes("services"))
}

function gcloud(argv, segment, ctx, env) {
  const { positionals, flags, rest } = parseArgs(argv.slice(1), GCLOUD_VALUES)
  const path = positionals.filter((item) => !GCLOUD_RELEASE.has(item))
  let readOnly
  let destructive = false
  const moved = path[0] === "storage" &&
    transfer(path[1], path.slice(2), "gs://", has(flags, "--delete-unmatched-destination-objects"))
  if (!path.length || path[0] === "help" || has(flags, "--help", "-h", "--version")) readOnly = true
  else if (moved) ({ readOnly, destructive } = moved)
  else {
    const verb = path.find((item) => gcloudRead(item) || gcloudDestructive(item, path))
    readOnly = Boolean(verb && gcloudRead(verb))
    destructive = Boolean(verb) && !readOnly
  }
  const ids = [
    ...values(flags, "--project").map((value) => id("gcloud project", value)),
    ...values(flags, "--configuration").map((value) => id("gcloud configuration", value)),
    ...values(flags, "--account", "--impersonate-service-account").map((value) => id("gcloud account", value)),
    ...explicitEnvIds(env, ctx, GCLOUD_ENV),
    ...bucketIds(path, "gs://"),
  ]
  const commands = [...values(flags, "--command"), ...(rest.length ? [rest.join(" ")] : [])]
  return {
    argv,
    readOnly,
    destructive,
    ids,
    implicit: ids.length ? [] : [...processEnvIds(ctx, GCLOUD_ENV), ...gcloudImplicit(ctx, env)],
    implicitNote: "gcloud would use the active configuration's project",
    nested: path.includes("ssh") ? commands.map((text) => ({ text, label: "a Compute Engine VM" })) : [],
  }
}

const GSUTIL_VALUES = words("-o -h -u -i -p -x -y -j -L -s -z")
const GSUTIL_POLICY = words(`iam acl defacl label lifecycle versioning cors logging web retention notification kms
  autoclass pap ubla rpo requesterpays bucketpolicyonly defstorageclass hmac`)

function gsutil(argv, segment, ctx, env) {
  const { positionals, flags } = parseArgs(argv.slice(1), GSUTIL_VALUES)
  const [sub = "", sub2 = ""] = positionals
  let readOnly = false
  let destructive = false
  const moved = transfer(sub, positionals.slice(1), "gs://", has(flags, "-d"))
  if (!sub || sub === "help" || sub === "version" || has(flags, "--help")) readOnly = true
  else if (moved) ({ readOnly, destructive } = moved)
  else if (GSUTIL_POLICY.has(sub)) {
    readOnly = sub2 === "get" || sub2 === "list" || (sub === "kms" && sub2 === "serviceaccount")
    destructive = (sub === "iam" && sub2 === "set") || sub2 === "delete"
  }
  if (sub === "rsync" && has(flags, "-n")) {
    readOnly = true
    destructive = false
  }
  const ids = [...bucketIds(positionals, "gs://"), ...values(flags, "-u").map((value) => id("gcloud project", value))]
  return { argv, readOnly, destructive, ids }
}

const AWS_VALUES = words(`--profile --region --output --endpoint-url --query --color --cli-input-json --cli-input-yaml
  --ca-bundle --cli-read-timeout --cli-connect-timeout --cli-binary-format`)
const AWS_READ_OP = /^(?:describe|list|get|lookup|search|batch-get|head|filter|scan|query|select|estimate|validate|simulate|test|preview|check|detect|download|wait|tail|help)(?:-|$)|^update-kubeconfig$/
const AWS_DESTRUCTIVE_OP = /^(?:delete|terminate|remove|deregister|purge|disable|revoke|detach|reset)(?:-|$)|^schedule-key-deletion$/
const AWS_ENV = [["AWS_PROFILE", "aws profile"], ["AWS_DEFAULT_PROFILE", "aws profile"]]

function aws(argv, segment, ctx, env) {
  const { positionals, flags } = parseArgs(argv.slice(1), AWS_VALUES)
  const [service = "", op = ""] = positionals
  let readOnly
  let destructive = false
  if (!service || service === "help" || op === "help" || has(flags, "--help", "--version")) readOnly = true
  else if (service === "s3") {
    const moved = transfer(op, positionals.slice(2), "s3://", has(flags, "--delete"))
    ;({ readOnly, destructive } = moved ?? { readOnly: false, destructive: false })
    if (has(flags, "--dryrun")) {
      readOnly = true
      destructive = false
    }
  } else if (service === "configure") readOnly = /^(?:list|get|list-profiles|export-credentials)$/.test(op)
  else if (service === "sso") readOnly = op === "login" || op === "logout"
  else {
    readOnly = AWS_READ_OP.test(op) || has(flags, "--dry-run")
    destructive = !readOnly && AWS_DESTRUCTIVE_OP.test(op)
  }
  const ids = [
    ...values(flags, "--profile").map((value) => id("aws profile", value)),
    ...values(flags, "--endpoint-url").map((value) => id("aws endpoint", value, "url")),
    ...explicitEnvIds(env, ctx, AWS_ENV),
    ...bucketIds(positionals, "s3://"),
  ]
  return {
    argv,
    readOnly,
    destructive,
    ids,
    implicit: ids.length ? [] : processEnvIds(ctx, AWS_ENV),
    implicitNote: "aws would use the default credential profile",
  }
}

const AZ_VALUES = words(`--subscription -g --resource-group -n --name -o --output --query -l --location --ids --method -m
  --url --uri --body --headers --resource --resource-type --scope --role --assignee --namespace --parameters
  --template-file`)
const AZ_READ = words(`list show exists query download download-batch version login logout find wait check-name
  get-credentials get-access-token`)

function azRead(item) {
  return AZ_READ.has(item) || /^(?:list|show|get)-/.test(item)
}

function azDestructive(item) {
  return /^(?:delete|purge)(?:-|$)/.test(item)
}

function az(argv, segment, ctx, env) {
  const { positionals, flags } = parseArgs(argv.slice(1), AZ_VALUES)
  let readOnly
  let destructive = false
  if (!positionals.length || positionals[0] === "version" || has(flags, "--help", "-h")) readOnly = true
  else if (positionals[0] === "rest") {
    const method = String(values(flags, "--method", "-m")[0] ?? "get").toLowerCase()
    readOnly = method === "get" || method === "head"
    destructive = method === "delete"
  } else {
    const verb = positionals.find((item) => azRead(item) || azDestructive(item))
    readOnly = Boolean(verb && azRead(verb))
    destructive = Boolean(verb) && !readOnly
  }
  const ids = [
    ...values(flags, "--subscription").map((value) => id("az subscription", value)),
    ...values(flags, "-g", "--resource-group").map((value) => id("az resource group", value)),
    ...explicitEnvIds(env, ctx, [["AZURE_SUBSCRIPTION_ID", "az subscription"], ["AZURE_DEFAULTS_GROUP", "az resource group"]]),
  ]
  return {
    argv,
    readOnly,
    destructive,
    ids,
    implicit: ids.length ? [] : azureImplicit(ctx),
    implicitNote: "az would use the default subscription",
  }
}

// ---------------------------------------------------------------------------
// Databases

function sqlStatements(text) {
  return text
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
}

const MONGO_DESTRUCTIVE = /\bdropDatabase\s*\(|\.drop\s*\(|\b(?:deleteMany|remove)\s*\(\s*\{\s*\}\s*\)|\bdropAllUsers\b/i
const MONGO_WRITE = /\b(?:insert\w*|update\w*|delete\w*|remove|drop\w*|replace\w*|rename\w*|create\w*|bulkWrite|findOneAnd\w*|findAndModify|save|runCommand|adminCommand|shutdownServer|eval|grantRolesToUser|revokeRolesFromUser)\s*\(|\$out\b|\$merge\b/i

function destructiveData(text) {
  if (/\b(?:flushall|flushdb)\b/i.test(text) || MONGO_DESTRUCTIVE.test(text)) return true
  return sqlStatements(text).some((statement) =>
    /\bdrop\s+(?:database|schema|table|owned)\b/i.test(statement) ||
    /\btruncate\b/i.test(statement) ||
    /\balter\s+table\b[\s\S]*\bdrop\b/i.test(statement) ||
    (/\bdelete\s+from\b/i.test(statement) && !/\bwhere\b/i.test(statement)) ||
    (/\bupdate\b[\s\S]+\bset\b/i.test(statement) && !/\bwhere\b/i.test(statement)))
}

const SQL_READ_START = /^(?:select|show|explain|describe|desc|with|values|table|use|\\(?:d\w*|l\+?|x|conninfo|timing|pset|q|echo|\?|h)\b|\.(?:tables|schema|indexes|indices|headers|mode|dump|databases|show|help|quit|exit|timer|width)\b)/i
const SQL_WRITE_WORD = /\b(?:insert|update|delete|merge|upsert|into|alter|create|drop|truncate|grant|revoke|copy|call|lock|vacuum|reindex|nextval|setval|set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|lo_unlink|dblink_exec)\b/i

function sqlReadOnly(text) {
  return sqlStatements(text).every((statement) => SQL_READ_START.test(statement) && !SQL_WRITE_WORD.test(statement))
}

// Statement text from inline flags, files, heredocs, `<` redirects and pipes.
function dataSources(inline, files, segment, ctx) {
  const texts = [...inline, ...segment.stdin]
  let opaque = false
  const readInto = (path) => {
    const text = ctx.remote ? null : readBounded(resolvePath(path, ctx), ctx.state)
    if (text == null) opaque = true
    else texts.push(text)
  }
  files.forEach(readInto)
  for (const item of segment.redirects) if (item.op === "<") readInto(item.target)
  const from = segment.pipeFrom
  if (from) {
    const [first, ...args] = from.words.map((item) => item.value)
    const name = commandName(first)
    texts.push(...from.stdin)
    if (name === "echo" || name === "printf") texts.push(args.join(" "))
    else if (name === "cat") args.filter((arg) => !arg.startsWith("-")).forEach(readInto)
    else if (!from.stdin.length) opaque = true
  }
  return { texts, opaque }
}

function dataInvocation(argv, ids, sources, informational, check, extra) {
  const visible = sources.texts.some((text) => text.trim())
  const destructive = sources.texts.some(destructiveData)
  const readOnly = !destructive && (informational || (visible && !sources.opaque && sources.texts.every(check)))
  return { argv, ids, readOnly, destructive, implicitNote: "the client would use its default connection", ...extra }
}

function hostIds(flags, names, label = "database host") {
  return values(flags, ...names).map((value) => id(label, value, "host"))
}

function connectionId(value) {
  return /:\/\/|=/.test(value) ? id("database URL", value, "url") : id("database", value)
}

const PSQL_VALUES = words(`-h --host -p --port -U --username -d --dbname -c --command -f --file -v --set --variable -o
  --output -P --pset -F --field-separator -R --record-separator -L --log-file -T --table-attr`)

function psql(argv, segment, ctx, env) {
  const { positionals, flags } = parseArgs(argv.slice(1), PSQL_VALUES)
  const ids = [
    ...hostIds(flags, ["-h", "--host"]),
    ...[...values(flags, "-d", "--dbname"), ...positionals.slice(0, 1)].map(connectionId),
    ...explicitEnvIds(env, ctx, [["PGHOST", "PGHOST", "host"], ["PGSERVICE", "PGSERVICE"]]),
  ]
  const sources = dataSources(values(flags, "-c", "--command"), values(flags, "-f", "--file").filter((file) => file !== "-"), segment, ctx)
  const informational = has(flags, "-l", "--list", "--version", "-V", "--help", "-?")
  return dataInvocation(argv, ids, sources, informational, sqlReadOnly, {
    implicit: processEnvIds(ctx, [["PGHOST", "PGHOST", "host"], ["PGSERVICE", "PGSERVICE"], ["DATABASE_URL", "DATABASE_URL", "url"]]),
  })
}

const MYSQL_VALUES = words(`-h --host -P --port -u --user -D --database -e --execute -S --socket --defaults-file
  --defaults-extra-file --login-path --protocol --default-character-set`)

function mysql(argv, segment, ctx, env) {
  const { positionals, flags } = parseArgs(argv.slice(1), MYSQL_VALUES, { attachedOnly: new Set(["-p"]) })
  const ids = [
    ...hostIds(flags, ["-h", "--host"]),
    ...hostIds(flags, ["-S", "--socket"], "database socket"),
    ...[...values(flags, "-D", "--database"), ...positionals.slice(0, 1)].map(connectionId),
    ...values(flags, "--login-path").map((value) => id("login path", value)),
    ...explicitEnvIds(env, ctx, [["MYSQL_HOST", "MYSQL_HOST", "host"]]),
  ]
  const sources = dataSources(values(flags, "-e", "--execute"), [], segment, ctx)
  const informational = has(flags, "--version", "-V", "--help", "-?")
  return dataInvocation(argv, ids, sources, informational, sqlReadOnly, {
    implicit: processEnvIds(ctx, [["MYSQL_HOST", "MYSQL_HOST", "host"]]),
  })
}

const MONGO_VALUES = words(`--host --port -u --username -p --password --eval -f --file --authenticationDatabase
  --authenticationMechanism --tlsCAFile --tlsCertificateKeyFile --apiVersion`)

function mongo(argv, segment, ctx, env) {
  const { positionals, flags } = parseArgs(argv.slice(1), MONGO_VALUES)
  const scripts = [...values(flags, "-f", "--file"), ...positionals.filter((item) => item.endsWith(".js"))]
  const ids = [
    ...hostIds(flags, ["--host"]),
    ...positionals.filter((item) => !item.endsWith(".js")).map((item) => (/^mongodb(?:\+srv)?:\/\//.test(item) ? id("database URL", item, "url") : id("database", item))),
  ]
  const sources = dataSources(values(flags, "--eval"), [], segment, ctx)
  if (scripts.length) sources.opaque = true
  const informational = has(flags, "--version", "--help", "-h")
  return dataInvocation(argv, ids, sources, informational, (text) => !MONGO_WRITE.test(text), {})
}

const REDIS_VALUES = words(`-h -p -s -a --user --pass -u -n -r -i -d --cacert --cacertdir --cert --key --sni --pattern
  --count --rdb --functions-rdb`)
const REDIS_READ = words(`get mget keys scan sscan hscan zscan exists type ttl pttl strlen hget hmget hgetall hkeys hvals
  hlen hexists hstrlen lrange llen lindex lpos smembers scard sismember smismember srandmember zrange zrangebyscore
  zrevrange zrevrangebyscore zrangebylex zcard zscore zmscore zrank zrevrank zcount zlexcount xrange xrevrange xlen
  xpending info ping dbsize time echo randomkey getrange bitcount bitpos getbit pfcount geopos geodist geosearch
  lastsave role`)
const REDIS_READ2 = {
  memory: words("usage stats doctor malloc-stats"),
  client: words("list info getname id"),
  config: words("get"),
  slowlog: words("get len"),
  latency: words("latest history doctor graph"),
  cluster: words("info nodes slots shards myid countkeysinslot getkeysinslot keyslot"),
  acl: words("list whoami users cat getuser log"),
  object: words("encoding freq idletime refcount"),
  command: words("count docs info list getkeys"),
  function: words("list dump stats"),
  module: words("list"),
  xinfo: null,
}
const REDIS_READ_FLAGS = ["--scan", "--bigkeys", "--memkeys", "--hotkeys", "--stat", "--latency", "--latency-history",
  "--latency-dist", "--intrinsic-latency", "--version", "--help"]

function redisReadOnly(positionals) {
  const [first = "", second = ""] = positionals.map((item) => item.toLowerCase())
  if (Object.hasOwn(REDIS_READ2, first)) return REDIS_READ2[first] === null || REDIS_READ2[first].has(second)
  return REDIS_READ.has(first)
}

function redis(argv, segment, ctx, env) {
  const { positionals, flags } = parseArgs(argv.slice(1), REDIS_VALUES)
  const ids = [
    ...hostIds(flags, ["-h"]),
    ...hostIds(flags, ["-s"], "redis socket"),
    ...values(flags, "-u").map((value) => id("redis URL", value, "url")),
  ]
  const sources = dataSources(positionals.length ? [positionals.join(" ")] : [], [], segment, ctx)
  const destructive = sources.texts.some(destructiveData) || positionals.some((item) => /^shutdown$/i.test(item))
  const piped = segment.stdin.length > 0 || Boolean(segment.pipeFrom) || segment.redirects.some((item) => item.op === "<")
  const readOnly = !destructive && (has(flags, ...REDIS_READ_FLAGS) || (positionals.length > 0 && !piped && redisReadOnly(positionals)))
  return { argv, ids, readOnly, destructive, implicitNote: "redis-cli would use its default connection" }
}

const SQLITE_VALUES = words("--cmd --init --separator --nullvalue --newline")

function sqlite(argv, segment, ctx, env) {
  const { positionals, flags } = parseArgs(argv.slice(1), SQLITE_VALUES, { singleDashLong: true })
  const [file, ...sql] = positionals
  const sources = dataSources([...values(flags, "--cmd"), ...(sql.length ? [sql.join(" ")] : [])], values(flags, "--init"), segment, ctx)
  const informational = has(flags, "--version", "--help")
  const inv = dataInvocation(argv, file ? [id("database file", file, "file")] : [], sources, informational, sqlReadOnly, {
    local: "a local SQLite database",
  })
  if (has(flags, "--readonly") && !inv.destructive) inv.readOnly = true
  return inv
}

function databaseAdmin(argv, segment, ctx, env) {
  const tool = commandName(argv[0])
  const { positionals, flags } = parseArgs(argv.slice(1), new Set([...PSQL_VALUES, "--uri", "--db", "--nsInclude"]))
  const ids = [
    ...hostIds(flags, ["-h", "--host"]),
    ...[...values(flags, "-d", "--dbname", "--uri"), ...positionals.slice(0, 1)].map(connectionId),
    ...explicitEnvIds(env, ctx, [["PGHOST", "PGHOST", "host"]]),
  ]
  const destructive = tool === "dropdb" || tool === "dropuser" ||
    (tool === "pg_restore" && has(flags, "-c", "--clean")) || (tool === "mongorestore" && has(flags, "--drop"))
  const readOnly = has(flags, "--help", "--version", "-V") || (tool === "pg_restore" && has(flags, "-l", "--list"))
  return { argv, ids, readOnly, destructive, implicit: processEnvIds(ctx, [["PGHOST", "PGHOST", "host"]]) }
}

// ---------------------------------------------------------------------------
// Remote shells and copies

const SSH_VALUES = new Set("bcDEeFIiJLlmOopQRSWwB".split("").map((letter) => `-${letter}`))

function sshHost(destination) {
  return destination.replace(/^ssh:\/\//, "").replace(/^[^@]*@/, "").replace(/:\d+$/, "").replace(/\/.*$/, "")
}

function bareShell(remote) {
  if (!remote.length) return true
  const argv = remote.join(" ").trim().split(/\s+/)
  return SHELLS.has(commandName(argv[0])) && !argv.slice(1).some((arg) => /^-[a-zA-Z]*c/.test(arg))
}

function ssh(argv, segment, ctx, env) {
  const flags = new Map()
  let k = 1
  while (k < argv.length && argv[k].startsWith("-") && argv[k].length > 1) {
    const arg = argv[k++]
    if (arg === "--") break
    for (let c = 1; c < arg.length; c++) {
      const name = `-${arg[c]}`
      if (SSH_VALUES.has(name)) {
        const value = arg.slice(c + 1) || argv[k++]
        flags.set(name, [...(flags.get(name) ?? []), value])
        break
      }
      flags.set(name, [true])
    }
  }
  const destination = argv[k]
  if (!destination) return undefined
  const remote = argv.slice(k + 1)
  const host = sshHost(destination)
  const ids = [
    id("ssh host", host, "host"),
    ...values(flags, "-J").flatMap((value) => value.split(",")).map((value) => id("ssh jump host", sshHost(value), "host")),
  ]
  const target = classifyTarget({ ids }, ctx)
  const stdin = bareShell(remote) ? dataSources([], [], segment, ctx) : { texts: [], opaque: false }
  const scripts = stdin.texts.filter((text) => text.trim())
  const tunnel = has(flags, "-N", "-L", "-R", "-D", "-W", "-w")
  const display = `\`${shown(argv)}\``
  if (target.cls === "prod") {
    if (tunnel && !remote.length) {
      return deny(ctx, "prod_mutation", `${display} opens an SSH tunnel to a production host (${target.evidence}); forwarded ports would hide the production target from later checks`)
    }
    if (!remote.length && !scripts.length) {
      return deny(ctx, "prod_mutation", `${display} opens an interactive shell on a production host (${target.evidence})`)
    }
    if (stdin.opaque && bareShell(remote)) {
      return deny(ctx, "prod_mutation", `${display} runs an unreadable script on a production host (${target.evidence})`)
    }
  } else if (!remote.length && !scripts.length) {
    noteInfra(ctx, `${shown(argv)} [${target.cls} ssh target: ${target.evidence}]`)
  }
  const child = { ...ctx, dir: undefined, vars: new Map(), remote: { cls: target.cls, label: `ssh host "${host}"` } }
  if (remote.length) analyzeText(remote.join(" "), child)
  for (const text of scripts) analyzeText(text, child)
  return undefined
}

const SCP_VALUES = words("-c -F -i -J -l -o -P -S -X")
const RSYNC_VALUES = words(`-e --rsh --exclude --include --filter -f --rsync-path --port --password-file --log-file
  --files-from --chmod --chown --timeout --bwlimit --backup-dir --suffix --compare-dest --link-dest --exclude-from
  --include-from -T --temp-dir --info --debug`)

function remotePathHost(path) {
  const url = /^(?:scp|sftp|rsync):\/\/(?:[^@/]+@)?([^:/]+)/.exec(path)
  if (url) return url[1]
  const spec = /^(?:[^@/:]+@)?([^:/\s]{2,}):(?!\/\/)/.exec(path)
  return spec ? spec[1] : null
}

function remoteCopy(argv, segment, ctx, env) {
  const tool = commandName(argv[0])
  const { positionals } = parseArgs(argv.slice(1), tool === "rsync" ? RSYNC_VALUES : SCP_VALUES)
  const host = tool === "sftp" ? sshHost(positionals[0] ?? "") : remotePathHost(positionals.at(-1) ?? "")
  if (!host || positionals.length < (tool === "sftp" ? 1 : 2)) return undefined
  return { argv, ids: [id("remote host", host, "host")], readOnly: false, destructive: false }
}

// ---------------------------------------------------------------------------
// Version control

const GIT_GLOBAL_VALUES = words("-C -c --git-dir --work-tree --namespace --exec-path --super-prefix --config-env")
const GIT_PUSH_VALUES = words("--repo -o --push-option --receive-pack --exec")

function protectedBranch(branch, ctx) {
  const name = branch.replace(/^refs\/heads\//, "").toLowerCase()
  return /^(?:main|master|trunk)$/.test(name) || /^releases?(?:$|[-_/.])/.test(name) ||
    Boolean(prodToken(tokensOf(name), ctx.state.protectedTargets))
}

function git(argv, segment, ctx, env) {
  let k = 1
  let dir = ctx.dir
  let explicitDir = false
  while (k < argv.length && argv[k].startsWith("-")) {
    const arg = argv[k]
    if (arg === "-C") {
      dir = resolvePath(argv[k + 1] ?? "", { ...ctx, dir })
      explicitDir = isAbsolute(argv[k + 1] ?? "") || (argv[k + 1] ?? "").startsWith("~")
    }
    k += GIT_GLOBAL_VALUES.has(arg) ? 2 : 1
  }
  // A pane's current branch is unknown, like its directory.
  const branchOf = () => (ctx.dirGuess && !explicitDir ? null : currentBranch(dir, ctx))
  if (argv[k] !== "push") return undefined
  const { positionals, flags } = parseArgs(argv.slice(k + 1), GIT_PUSH_VALUES)
  if (has(flags, "-n", "--dry-run")) return undefined
  const force = has(flags, "-f", "--force", "--force-with-lease", "--force-if-includes")
  const removing = has(flags, "-d", "--delete")
  const display = `\`${shown(argv)}\``
  if (has(flags, "--mirror", "--prune") || (force && has(flags, "--all", "--branches"))) {
    return deny(ctx, "protected_branch_rewrite", `${display} force-updates or prunes every remote branch, including protected ones`)
  }
  const targets = []
  for (const spec of positionals.slice(1)) {
    const plus = spec.startsWith("+")
    const body = plus ? spec.slice(1) : spec
    const colon = body.indexOf(":")
    const source = colon >= 0 ? body.slice(0, colon) : body
    const dest = colon >= 0 ? body.slice(colon + 1) : body
    const deleting = removing || (colon >= 0 && !source)
    if (!force && !plus && !deleting) continue
    const branch = !dest || dest === "HEAD" || dest === "@" ? branchOf() : dest
    targets.push({ branch, deleting })
  }
  if (positionals.length <= 1 && (force || removing)) targets.push({ branch: branchOf(), deleting: removing })
  for (const target of targets) {
    if (target.branch && !protectedBranch(target.branch, ctx)) continue
    const what = target.branch ? `protected branch "${target.branch}"` : "the current branch, which could not be resolved"
    return deny(ctx, "protected_branch_rewrite", `${display} ${target.deleting ? "deletes" : "force-pushes"} ${what}`)
  }
  return undefined
}

const FORGE_VALUES = words("-R --repo -X --method -H --header -f --field -F --raw-field --hostname -q --jq -t --template")

function forge(argv, segment, ctx, env) {
  const { positionals, flags } = parseArgs(argv.slice(1), FORGE_VALUES)
  const display = `\`${shown(argv)}\``
  if (positionals[0] === "repo" && positionals[1] === "delete") return deny(ctx, "repo_delete", `${display} deletes a repository`)
  if (positionals[0] === "api") {
    const method = String(values(flags, "-X", "--method")[0] ?? "").toUpperCase()
    if (method === "DELETE" && /^\/?(?:repos\/[^/]+\/[^/]+|projects\/[^/]+)\/?$/.test(positionals[1] ?? "")) {
      return deny(ctx, "repo_delete", `${display} deletes a repository`)
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Other deploy/infrastructure CLIs: verb sets plus target flags.

const GENERIC_READ = words(`get list ls describe show status logs log version help diff plan preview info whoami history
  top explain inspect lint template validate render search view cat tail output outputs read check stats events ps
  images df port`)
const GENERIC_DESTRUCTIVE = words(`delete del destroy rm rmi remove uninstall purge terminate prune drop wipe nuke teardown
  down rollback kill`)
const GENERIC_READ_FLAGS = ["--help", "-h", "--version", "--dry-run", "--check", "-C", "--syntax-check", "--list-hosts", "--list-tasks", "--list-tags"]
const GENERIC_INFRA = new Map(Object.entries({
  argocd: { ids: "--server --kube-context --context", env: "ARGOCD_SERVER" },
  flux: { ids: "--context --cluster --kubeconfig", kube: true },
  pulumi: { ids: "-s --stack" },
  "ansible-playbook": { ids: "-i --inventory -l --limit" },
  ansible: { ids: "-i --inventory", positionalId: "ansible hosts" },
  eksctl: { ids: "--cluster --profile -f --config-file" },
  kops: { ids: "--name --state" },
  velero: { ids: "--kubecontext --kubeconfig", kube: true },
  istioctl: { ids: "--context --kubeconfig", kube: true },
  linkerd: { ids: "--context --kubeconfig", kube: true },
  cilium: { ids: "--context --kubeconfig", kube: true },
  skaffold: { ids: "--kube-context -p --profile", kube: true },
  cdk: { ids: "--profile -c --context" },
  cdktf: { ids: "--var-file" },
  serverless: { ids: "-s --stage --aws-profile" },
  sls: { ids: "-s --stage --aws-profile" },
  vercel: { ids: "--scope --target --prod" },
  netlify: { ids: "--site --context" },
  fly: { ids: "-a --app -c --config" },
  flyctl: { ids: "-a --app -c --config" },
  heroku: { ids: "-a --app -r --remote" },
  wrangler: { ids: "-e --env" },
  firebase: { ids: "-P --project" },
  doctl: { ids: "--context" },
  hcloud: { ids: "--context" },
  oci: { ids: "--profile" },
  nomad: { ids: "--address", env: "NOMAD_ADDR", singleDash: true },
  vault: { ids: "--address", env: "VAULT_ADDR", singleDash: true },
  consul: { ids: "--http-addr", env: "CONSUL_HTTP_ADDR", singleDash: true },
}))

function genericVerb(positionals, flags) {
  if (has(flags, ...GENERIC_READ_FLAGS)) return { readOnly: true, destructive: false }
  for (const item of positionals.flatMap((value) => value.toLowerCase().split(":"))) {
    if (GENERIC_READ.has(item)) return { readOnly: true, destructive: false }
    if (GENERIC_DESTRUCTIVE.has(item)) return { readOnly: false, destructive: true }
  }
  return { readOnly: false, destructive: false }
}

function genericInfra(argv, segment, ctx, env) {
  const spec = GENERIC_INFRA.get(commandName(argv[0]))
  const idFlags = words(spec.ids)
  const { positionals, flags } = parseArgs(argv.slice(1), idFlags, { singleDashLong: spec.singleDash })
  const ids = [...idFlags].flatMap((flag) => values(flags, flag).map((value) => id(flag.replace(/^-+/, ""), value)))
  if (spec.env) ids.push(...explicitEnvIds(env, ctx, [[spec.env, spec.env, "url"]]))
  if (spec.positionalId && positionals[0]) ids.push(id(spec.positionalId, positionals[0]))
  const scoped = ids.length > 0
  if (spec.kube) ids.push(...kubeconfigIds(new Map(), env, ctx))
  const implicit = scoped ? [] : [
    ...(spec.env ? processEnvIds(ctx, [[spec.env, spec.env, "url"]]) : []),
    ...(spec.kube ? kubeImplicit(ctx, []) : []),
  ]
  return { argv, ...genericVerb(positionals, flags), ids, implicit }
}

function kubectx(argv, segment, ctx, env) {
  const { positionals, flags } = parseArgs(argv.slice(1), new Set())
  if (!positionals.length || has(flags, "-c", "--current", "-h", "--help")) return undefined
  return { argv, readOnly: false, destructive: false, ids: positionals.filter((item) => item !== "-").map((item) => id("kube context", item)) }
}

const CONTAINER_VALUES = words("-H --host -c --context --url --connection --config --log-level -l")
const LOCAL_CONTAINER_TARGET = /^(?:unix|npipe):\/\/|^(?:default|desktop-linux)$/

// Local container engines are ordinary development; only remote engines count.
function containerEngine(argv, segment, ctx, env) {
  const { positionals, flags } = parseArgs(argv.slice(1), CONTAINER_VALUES)
  const ids = [
    ...values(flags, "-H", "--host", "--url").map((value) => id("container host", value, "url")),
    ...values(flags, "-c", "--context", "--connection").map((value) => id("container context", value)),
    ...explicitEnvIds(env, ctx, [["DOCKER_HOST", "DOCKER_HOST", "url"], ["DOCKER_CONTEXT", "DOCKER_CONTEXT"], ["CONTAINER_HOST", "CONTAINER_HOST", "url"]]),
  ].filter((item) => !LOCAL_CONTAINER_TARGET.test(item.value) &&
    (!nonProdId(item, ctx) || prodToken(tokensOf(item.value), ctx.state.protectedTargets)))
  const implicit = ids.length ? [] : dockerImplicit(ctx)
  if (!ids.length && !implicit.some((item) => prodToken(tokensOf(item.value), ctx.state.protectedTargets))) return undefined
  return { argv, ...genericVerb(positionals, flags), ids, implicit }
}

// ---------------------------------------------------------------------------
// Command dispatch

const SHELLS = words("sh bash zsh dash ksh mksh ash fish busybox")
const INTERPRETERS = new Map(Object.entries({
  python: "-c", python3: "-c", python2: "-c", pypy3: "-c",
  node: "-e --eval -p --print", nodejs: "-e --eval -p --print", bun: "-e --eval -p --print", deno: "--eval",
  ruby: "-e", perl: "-e -E", php: "-r", osascript: "-e",
}))
const RUNNERS = words(`make gmake just task mage npm pnpm yarn rake invoke inv fab earthly turbo nx cargo go dotnet mvn
  gradle gradlew sbt mix tsx ts-node`)
const PACKAGE_EXEC = words("exec dlx x")
const DEPLOY_VERBS = words(`deploy deployment deploys release releases apply destroy teardown rollout rollback promote
  publish migrate migration migrations provision ship push up down delete remove drop reset restart scale sync seed
  purge wipe nuke cutover failover`)
const TESTISH = words("test tests pytest jest vitest spec specs dry dryrun")
const SHELL_KEYWORDS = words("if then else elif do while until ! {")
const IGNORED = words("for case select fi done esac } [[ [ test true false : return break continue exit")
const DECLARATIONS = words("export declare local readonly typeset")
const TEXT_COMMANDS = words("echo printf grep egrep fgrep zgrep rg ag ack jq yq sed awk gawk logger say notify-send column wc")
const MESSAGE_COMMANDS = words("git gh glab hub")
const MESSAGE_FLAGS = words("-m --message -b --body -d --description -t --title --notes --subject")

const CORE_WRAPPERS = new Map(Object.entries({
  sudo: { values: words("-u -g -h -p -C -D -r -t -U -T -R --user --group --host --prompt --chdir --role --type --other-user"), assignments: true },
  doas: { values: words("-u -C") },
  env: { values: words("-u -C -P --unset --chdir"), assignments: true },
  command: {},
  builtin: {},
  exec: { values: words("-a") },
  nohup: {},
  time: { values: words("-f -o") },
  nice: { values: words("-n --adjustment") },
  ionice: { values: words("-c -n -p --class --classdata --pid") },
  timeout: { values: words("-s -k --signal --kill-after"), positional: 1 },
  gtimeout: { values: words("-s -k --signal --kill-after"), positional: 1 },
  stdbuf: { values: words("-i -o -e --input --output --error") },
  caffeinate: { values: words("-t -w") },
  xargs: { values: words("-I -L -n -P -d -E -s -a --max-args --max-procs --delimiter --replace --arg-file --max-lines --eof --max-chars --process-slot-var") },
  watch: { values: words("-n --interval -q --equexit"), joins: true },
  chronic: {},
  unbuffer: {},
  flock: { values: words("-w -E --timeout --conflict-exit-code"), positional: 1 },
}))
const SCAN_WRAPPERS = words(`op aws-vault direnv nix nix-shell devbox mise rtx asdf uv poetry pipenv bundle npx bunx pnpx
  dotenv infisical doppler sops tsh retry torsocks proxychains proxychains4 find fd parallel entr script ssh-agent chamber
  summon teller`)

// Terminal relays type text into interactive panes.
const TMUX_KEY = /^(?:[CMS]-.+|Enter|Escape|Space|Tab|BTab|BSpace|Up|Down|Left|Right|Home|End|PageUp|PgUp|PageDown|PgDn|NPage|PPage|DC|IC|F\d{1,2}|KP\w+)$/

function tmuxKey(key) {
  if (/^(?:Enter|C-m|C-j|KPEnter)$/.test(key)) return "\n"
  return key === "Space" || key === "Tab" || key === "BTab" ? " " : "\n"
}

function ternKey(combo) {
  if (combo.length === 1) return combo
  if (/^(?:enter|return|kp_?enter|ctrl\+[mj])$/i.test(combo)) return "\n"
  return /^(?:space|tab)$/i.test(combo) ? " " : "\n"
}

function relayedTexts(name, argv) {
  const texts = []
  if (name === "tmux") {
    for (let k = 1; k < argv.length; k++) {
      if (argv[k] !== "send-keys" && argv[k] !== "send") continue
      let literal = false
      let j = k + 1
      while (j < argv.length && /^-[A-Za-z]+$/.test(argv[j])) {
        if (argv[j].includes("l")) literal = true
        j += /[tNc]$/.test(argv[j]) ? 2 : 1
      }
      if (argv[j] === "--") j++
      let text = ""
      for (; j < argv.length && argv[j] !== ";"; j++) text += literal || !TMUX_KEY.test(argv[j]) ? argv[j] : tmuxKey(argv[j])
      texts.push(text)
      k = j
    }
  } else if (name === "tern") {
    // tern send BLOCK keys COMBO... | text TEXT | paste TEXT
    const send = argv.indexOf("send")
    let j = send + 1
    while (send > 0 && j < argv.length && argv[j].startsWith("-")) j += argv[j] === "--window" ? 2 : 1
    const mode = argv[j + 1]
    const rest = argv.slice(j + 2).filter((arg) => arg !== "--json")
    if (send > 0 && (mode === "text" || mode === "paste")) texts.push(rest.join(" "))
    else if (send > 0 && mode === "keys") texts.push(rest.map(ternKey).join(""))
  } else if (name === "screen") {
    const stuff = argv.indexOf("stuff")
    if (stuff > 0 && argv[stuff + 1] !== undefined) texts.push(argv[stuff + 1].replace(/\^[MJ]|\\[nr]|\\01[25]/g, "\n"))
  }
  return texts
}

function terminalRelay(argv, segment, ctx, env) {
  const relayed = { ...ctx, dirGuess: true, vars: new Map(ctx.vars) }
  for (const text of relayedTexts(commandName(argv[0]), argv)) analyzeText(text, relayed)
  // Other relays (zellij write-chars, wezterm/kitty send-text, ...): any argument may be typed text.
  for (const arg of argv.slice(1)) if (!arg.startsWith("-")) analyzeText(arg, relayed)
  if (!ctx.state.deny) unwrapScan(argv, 1, segment, ctx, env)
  return undefined
}

const HANDLERS = new Map([
  ...["kubectl", "kubecolor", "oc"].map((name) => [name, kubectl]),
  ["helm", helm],
  ["helmfile", helmfile],
  ...["terraform", "tofu", "terragrunt"].map((name) => [name, iac]),
  ["terramate", terramate],
  ["gcloud", gcloud],
  ["gsutil", gsutil],
  ["aws", aws],
  ["az", az],
  ["psql", psql],
  ...["mysql", "mariadb"].map((name) => [name, mysql]),
  ...["mongosh", "mongo"].map((name) => [name, mongo]),
  ...["redis-cli", "valkey-cli"].map((name) => [name, redis]),
  ...["sqlite3", "sqlite"].map((name) => [name, sqlite]),
  ...["dropdb", "dropuser", "createdb", "createuser", "pg_restore", "mongorestore"].map((name) => [name, databaseAdmin]),
  ...["ssh", "autossh"].map((name) => [name, ssh]),
  ...["scp", "sftp", "rsync"].map((name) => [name, remoteCopy]),
  ["git", git],
  ...["gh", "glab"].map((name) => [name, forge]),
  ...[...GENERIC_INFRA.keys()].map((name) => [name, genericInfra]),
  ["kubectx", kubectx],
  ...["tmux", "tern", "screen", "zellij", "wezterm", "kitty"].map((name) => [name, terminalRelay]),
  ...["docker", "podman"].map((name) => [name, containerEngine]),
])

const KNOWN_COMMANDS = new Set([
  ...HANDLERS.keys(), ...SHELLS, ...INTERPRETERS.keys(), ...RUNNERS, ...CORE_WRAPPERS.keys(), ...SCAN_WRAPPERS,
  "eval",
])

function isCommandWord(word) {
  if (!word || word.startsWith("-")) return false
  return KNOWN_COMMANDS.has(commandName(word)) || (word.includes("/") && /\.(?:sh|bash|zsh)$/.test(word))
}

function analyzeSegment(segment, ctx) {
  const argv = segment.words.map((item) => expandVariables(item.value, ctx.vars))
  recordVirtualFile(segment, argv, ctx)
  const name = commandName(argv.find((arg) => !ASSIGNMENT.test(arg)))
  if (!TEXT_COMMANDS.has(name)) {
    const messages = MESSAGE_COMMANDS.has(name)
    for (let k = 0; k < argv.length; k++) {
      if (messages && (MESSAGE_FLAGS.has(argv[k - 1]) || /^--(?:message|body|description|title)=/.test(argv[k]))) continue
      // Strings may be commands for another shell: bash -c, ssh, tmux send-keys, tern send, su -c, ...
      // A word that is the whole current text (e.g. `$(git rev-parse --show-toplevel)`) would recurse forever.
      if (/\s/.test(argv[k]) && argv[k] !== ctx.text) analyzeText(argv[k], ctx)
    }
  }
  if (!ctx.state.deny) analyzeArgv(argv, segment, ctx, new Map())
}

// echo/printf/cat/tee writing a file in the same command: remember the content
// so a later `bash file` in that command is still inspected.
function recordVirtualFile(segment, argv, ctx) {
  if (ctx.remote) return
  const name = commandName(argv[0])
  let content
  let targets = segment.redirects.filter((item) => item.op === ">" || item.op === ">>" || item.op === ">|")
  if (name === "echo" || name === "printf") content = argv.slice(1).filter((arg) => !/^-[neE]+$/.test(arg)).join(" ")
  else if ((name === "cat" || name === "tee") && segment.stdin.length) {
    content = segment.stdin.join("\n")
    if (name === "tee") targets = [...targets, ...argv.slice(1).filter((arg) => !arg.startsWith("-")).map((target) => ({ op: ">", target }))]
  }
  if (content === undefined) return
  for (const item of targets) {
    const path = resolvePath(item.target, ctx)
    if (!path || !isAbsolute(path)) continue
    const previous = item.op === ">>" ? ctx.state.virtualFiles.get(path) ?? "" : ""
    ctx.state.virtualFiles.set(path, `${previous}${content}\n`)
  }
}

function analyzeArgv(input, segment, ctx, env) {
  if (ctx.state.deny) return
  let k = 0
  while (k < input.length && ASSIGNMENT.test(input[k])) setAssignment(env, input[k++])
  if (k >= input.length) {
    for (const [key, value] of env) ctx.vars.set(key, value)
    return
  }
  const argv = k ? input.slice(k) : input
  const alias = ctx.remote ? undefined : ctx.state.aliases.get(argv[0])
  if (alias !== undefined && !ctx.aliasing?.includes(argv[0])) {
    // Only interactive shells expand aliases; elsewhere the name just fails,
    // so analyzing the expansion as well costs nothing.
    const prefix = [...env].map(([key, value]) => `${key}=${shellQuote(value)}`)
    analyzeText([...prefix, alias, ...argv.slice(1).map(shellQuote)].join(" "), { ...ctx, aliasing: [...(ctx.aliasing ?? []), argv[0]] })
    if (ctx.state.deny) return
  }
  const name = commandName(argv[0])
  if (SHELL_KEYWORDS.has(name)) return analyzeArgv(argv.slice(1), segment, ctx, env)
  if (IGNORED.has(name)) return
  if (name === "function") {
    const body = argv.indexOf("{")
    return body > 0 ? analyzeArgv(argv.slice(body + 1), segment, ctx, env) : undefined
  }
  if (name === "cd" || name === "pushd") {
    const target = argv[1]
    if (target === "-") ctx.dir = undefined
    else ctx.dir = target ? resolvePath(target, ctx) : ctx.state.env.HOME
    if (!target || isAbsolute(target) || target.startsWith("~")) ctx.dirGuess = false
    return
  }
  if (DECLARATIONS.has(name)) {
    for (const arg of argv.slice(1)) if (ASSIGNMENT.test(arg)) setAssignment(ctx.vars, arg)
    return
  }
  if (name === "eval") return analyzeText(argv.slice(1).join(" "), ctx)
  if (name === "source" || name === ".") return runScript(argv[1], argv, segment, ctx, true)
  const handler = HANDLERS.get(name)
  if (handler) return judge(handler(argv, segment, ctx, env), segment, ctx)
  if (CORE_WRAPPERS.has(name)) return unwrapCore(name, argv, segment, ctx, env)
  if (SCAN_WRAPPERS.has(name)) return unwrapScan(argv, 1, segment, ctx, env)
  if (SHELLS.has(name)) return runShell(argv, segment, ctx, env)
  if (INTERPRETERS.has(name)) {
    runInterpreter(name, argv, segment, ctx)
    runnerHeuristic(argv, ctx, env)
    if (PACKAGE_EXEC.has(argv[1])) unwrapScan(argv, 2, segment, ctx, env)
    return remoteCheck(argv, segment, ctx)
  }
  if (RUNNERS.has(name)) {
    runnerHeuristic(argv, ctx, env)
    if (PACKAGE_EXEC.has(argv[1])) unwrapScan(argv, 2, segment, ctx, env)
    return remoteCheck(argv, segment, ctx)
  }
  if (argv[0].includes("/")) {
    runScript(argv[0], argv, segment, ctx, false)
    return runnerHeuristic(argv, ctx, env)
  }
  remoteCheck(argv, segment, ctx)
}

function unwrapCore(name, argv, segment, ctx, env) {
  const spec = CORE_WRAPPERS.get(name)
  let k = 1
  let skip = spec.positional ?? 0
  while (k < argv.length) {
    const arg = argv[k]
    if (arg === "--") {
      k++
      break
    }
    if (spec.assignments && ASSIGNMENT.test(arg)) {
      setAssignment(env, arg)
      k++
      continue
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (name === "command" && /^-[a-zA-Z]*[vV]/.test(arg)) return
      if (name === "env" && (arg === "-S" || arg.startsWith("--split-string"))) {
        return analyzeText(arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[k + 1] ?? "", ctx)
      }
      if (name === "env" && (arg === "-C" || arg === "--chdir")) ctx = { ...ctx, dir: resolvePath(argv[k + 1], ctx) }
      k += spec.values?.has(arg) ? 2 : 1
      continue
    }
    if (skip > 0) {
      skip--
      k++
      continue
    }
    break
  }
  const rest = argv.slice(k)
  if (!rest.length) return remoteCheck(argv, segment, ctx)
  if (spec.joins && !argv.slice(1, k).includes("-x")) return analyzeText(rest.join(" "), ctx)
  analyzeArgv(rest, segment, ctx, env)
}

// Long-tail wrappers (aws-vault exec, op run, tmux, find -exec, ...): the
// wrapped command follows `--` or is the first known command word. A word
// right after the wrapper is its own subcommand (`aws-vault exec`), not a
// builtin.
function unwrapScan(argv, start, segment, ctx, env) {
  const dashes = argv.indexOf("--", start)
  if (dashes >= 0 && dashes + 1 < argv.length) return analyzeArgv(argv.slice(dashes + 1), segment, ctx, env)
  for (let k = start; k < argv.length; k++) {
    const arg = argv[k]
    if (ASSIGNMENT.test(arg)) setAssignment(env, arg)
    else if (isCommandWord(arg) && !(k === start && CORE_WRAPPERS.has(commandName(arg)))) {
      return analyzeArgv(argv.slice(k), segment, ctx, env)
    }
  }
  remoteCheck(argv, segment, ctx)
}

const SHELL_SHEBANG = /\b(?:ba|z|da|k|mk|a)?sh\b/

function runScript(path, argv, segment, ctx, force) {
  if (!path) return
  if (ctx.remote) return remoteCheck(argv.length ? argv : [path], segment, ctx)
  const text = readBounded(resolvePath(path, ctx), ctx.state)
  if (text == null) return
  const shebang = /^#!([^\n]*)/.exec(text)
  if (!force && shebang && !SHELL_SHEBANG.test(shebang[1])) return
  analyzeText(text, { ...ctx, vars: new Map(ctx.vars) })
}

function runShell(argv, segment, ctx, env) {
  let k = 1
  let command = null
  while (k < argv.length) {
    const arg = argv[k]
    if (arg === "--" || arg === "-") {
      k++
      break
    }
    if (/^[-+]/.test(arg) && arg.length > 1) {
      if (/^[-+][oO]$/.test(arg) || arg === "--rcfile" || arg === "--init-file") {
        k += 2
        continue
      }
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) {
        command = argv[k + 1] ?? ""
        break
      }
      k++
      continue
    }
    break
  }
  if (command !== null) return analyzeText(command, ctx)
  if (argv[k] !== undefined) {
    runScript(argv[k], argv.slice(k), segment, ctx, true)
    return runnerHeuristic(argv.slice(k), ctx, env)
  }
  for (const text of segment.stdin) analyzeText(text, ctx)
  for (const item of segment.redirects) if (item.op === "<") runScript(item.target, [], EMPTY_SEGMENT, ctx, true)
  const from = segment.pipeFrom
  if (!from) return
  const [first, ...args] = from.words.map((item) => item.value)
  const name = commandName(first)
  for (const text of from.stdin) analyzeText(text, ctx)
  if (name === "echo" || name === "printf") {
    for (const arg of args) analyzeText(arg, ctx)
    analyzeText(args.join(" "), ctx)
  } else if (name === "cat") {
    for (const arg of args) if (!arg.startsWith("-")) runScript(arg, [], EMPTY_SEGMENT, ctx, true)
  }
}

function runInterpreter(name, argv, segment, ctx) {
  const inline = words(INTERPRETERS.get(name))
  const language = /^(?:python|pypy)/.test(name) ? "py" : /^(?:node|bun|deno)/.test(name) ? "js" : undefined
  for (let k = 1; k < argv.length; k++) {
    const arg = argv[k]
    if (inline.has(arg) && argv[k + 1] !== undefined) analyzeCode(argv[++k], ctx, language)
    else if (arg.startsWith("--eval=") || arg.startsWith("--print=")) analyzeCode(arg.slice(arg.indexOf("=") + 1), ctx, language)
    else if (name === "deno" && arg === "eval" && argv[k + 1] !== undefined) analyzeCode(argv[++k], ctx, language)
  }
  for (const text of segment.stdin) analyzeCode(text, ctx, language)
}

// Task runners and local scripts are opaque, but `make deploy-prod`,
// `npm run migrate:production` or `./release.sh prod` say what they do.
function runnerHeuristic(argv, ctx, env) {
  const tokens = tokensOf([...argv, ...env.values()].join(" "))
  const hit = prodToken(tokens, ctx.state.protectedTargets) ?? ctx.taint
  if (!hit || ctx.state.deny) return
  const verb = tokens.find((token) => DEPLOY_VERBS.has(token))
  if (!verb || tokens.some((token) => TESTISH.has(token))) return
  deny(ctx, "prod_mutation", `\`${shown(argv)}\` looks like a production ${verb} through a task runner or script (${hit})`)
}

const REMOTE_READ = words(`cat ls ll head tail grep egrep fgrep zgrep zcat rg wc sort uniq cut tr column jq yq df du free
  uptime ps pgrep hostname whoami id uname date env printenv which type echo printf true false test [ stat file
  readlink realpath basename dirname pwd ss netstat lsof dig nslookup host ping traceroute nproc lscpu lsblk getent
  last w who md5sum sha256sum sha1sum cksum diff cmp strings od xxd less more tree top htop iostat vmstat mpstat sar
  dmesg mount`)
const SYSTEMCTL_READ = words("status show list-units list-unit-files list-timers list-sockets list-dependencies is-active is-enabled is-failed cat")
const CONTAINER_READ = words("ps logs inspect images stats top version info port history")

function remoteReadOnly(argv, segment) {
  const writes = segment.redirects.some((item) =>
    /^(?:>|>>|>\||&>|&>>|<>)$/.test(item.op) && !/^(?:\/dev\/(?:null|stdout|stderr)|\d|-)$/.test(item.target))
  if (writes) return false
  const name = commandName(argv[0])
  const args = argv.slice(1)
  if (REMOTE_READ.has(name)) return true
  switch (name) {
    case "journalctl":
      return !args.some((arg) => /^--(?:vacuum|rotate|flush|sync|relinquish|setup-keys)/.test(arg))
    case "systemctl":
      return SYSTEMCTL_READ.has(args.find((arg) => !arg.startsWith("-")) ?? "status")
    case "docker":
    case "podman": {
      const positional = args.filter((arg) => !arg.startsWith("-"))
      return CONTAINER_READ.has(positional[0]) || (positional[0] === "compose" && /^(?:ps|logs|config|images|top|ls|version)$/.test(positional[1] ?? ""))
    }
    case "find":
      return !args.some((arg) => /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(arg))
    case "sed":
      return !args.some((arg) => /^--in-place|^-[a-zA-Z]*i/.test(arg))
    case "awk":
    case "gawk":
      return !args.some((arg) => /system\s*\(|\|\s*"|>\s*"/.test(arg))
    case "curl":
      return !args.some((arg, index) =>
        /^(?:-d|--data.*|-F|--form.*|-T|--upload-file|--json)$/.test(arg) ||
        (/^(?:-X|--request)$/.test(arg) && !/^(?:GET|HEAD)$/i.test(args[index + 1] ?? "")))
    case "ip":
      return !args.some((arg) => /^(?:add|del|delete|set|flush|change|replace|append)$/.test(arg))
    case "sysctl":
      return !args.some((arg) => arg === "-w" || arg.includes("="))
    case "crontab":
      return args.includes("-l")
    default:
      return false
  }
}

function remoteCheck(argv, segment, ctx) {
  if (!ctx.remote || ctx.state.deny || remoteReadOnly(argv, segment)) return
  if (ctx.remote.cls === "prod") {
    return deny(ctx, "prod_mutation", `\`${shown(argv)}\` runs on ${ctx.remote.label}, a production target, and is not a read-only command`)
  }
  if (ctx.remote.cls === "trusted") return
  noteInfra(ctx, `${shown(argv)} on ${ctx.remote.label}`)
}

// ---------------------------------------------------------------------------
// Text entry points

function analyzeText(text, ctx) {
  const { state } = ctx
  if (state.deny || typeof text !== "string" || !text.trim()) return
  if (ctx.depth >= MAX_DEPTH || state.budget <= 0) {
    state.truncated = true
    return
  }
  const body = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text
  if (body.length < text.length) state.truncated = true
  state.budget -= body.length
  const hit = ctx.taint ? null : prodToken(tokensOf(body), state.protectedTargets)
  const local = {
    ...ctx,
    depth: ctx.depth + 1,
    vars: new Map(ctx.vars),
    taint: ctx.taint ?? (hit ? `${hit} in the command text` : null),
    text: body,
  }
  const { segments, substitutions } = parseShell(body)
  for (const inner of substitutions) analyzeText(inner, { ...local, vars: new Map(local.vars) })
  for (const segment of segments) {
    if (state.deny) return
    analyzeSegment(segment, local)
  }
}

// Code is not shell: analyze every string literal as shell text, then look
// for argv lists such as subprocess.run(["kubectl", "--context", ...]) by
// dropping quotes, commas and brackets.
function codeView(code, language) {
  const strings = []
  let pseudo = ""
  let depth = 0
  let i = 0
  while (i < code.length) {
    const c = code[i]
    if (c === '"' || c === "'" || c === "`") {
      const triple = c !== "`" && code.startsWith(c.repeat(3), i)
      const quote = triple ? c.repeat(3) : c
      let j = i + quote.length
      let value = ""
      while (j < code.length && !code.startsWith(quote, j)) {
        if (code[j] === "\\") {
          value += code[j + 1] ?? ""
          j += 2
          continue
        }
        if (!triple && c !== "`" && code[j] === "\n") break
        value += code[j++]
      }
      strings.push(value)
      pseudo += ` ${value.replace(/[\s()[\]{},;]+/g, " ")} `
      i = j + quote.length
    } else if ((c === "#" && language !== "js") || (c === "/" && code[i + 1] === "/" && language !== "py")) {
      const end = code.indexOf("\n", i)
      i = end < 0 ? code.length : end
    } else if ("([{".includes(c)) {
      depth++
      pseudo += " "
      i++
    } else if (")]}".includes(c)) {
      depth = Math.max(0, depth - 1)
      pseudo += " "
      i++
    } else if (c === "," ) {
      pseudo += " "
      i++
    } else if (c === ";" || (c === "\n" && depth === 0)) {
      pseudo += "\n"
      i++
    } else {
      pseudo += c === "\n" ? " " : c
      i++
    }
  }
  return { strings, statements: pseudo.split("\n").map((line) => line.trim().split(/\s+/).filter(Boolean)) }
}

function analyzeCode(code, ctx, language) {
  const { state } = ctx
  if (state.deny || typeof code !== "string" || !code.trim()) return
  if (ctx.depth >= MAX_DEPTH || state.budget <= 0) {
    state.truncated = true
    return
  }
  const body = code.length > MAX_TEXT ? code.slice(0, MAX_TEXT) : code
  state.budget -= body.length
  const hit = ctx.taint ? null : prodToken(tokensOf(body), state.protectedTargets)
  const local = { ...ctx, depth: ctx.depth + 1, vars: new Map(ctx.vars), taint: ctx.taint ?? (hit ? `${hit} in the code` : null) }
  const { strings, statements } = codeView(body, language)
  for (const value of strings) if (/\s/.test(value)) analyzeText(value, local)
  for (const tokens of statements) {
    if (state.deny) return
    const k = tokens.findIndex((token, index) => isCommandWord(token) && !/^(?:=|==|===|:|\+=|-=|=>|\.)/.test(tokens[index + 1] ?? ""))
    if (k >= 0) analyzeArgv(tokens.slice(k), EMPTY_SEGMENT, local, new Map())
  }
}

// Field names that carry commands in xd:// devices and other tools.
const EXEC_KEYS = words("command commands cmd code script expression shell exec")

function parseFields(resources) {
  const fields = []
  for (const resource of resources) {
    const match = /^([A-Za-z0-9_.$[\]-]+): ([\s\S]*)$/.exec(resource)
    if (match) fields.push([match[1], match[2]])
  }
  return fields
}

function analyzeToolArgs(fields, ctx, action, device) {
  const entries = fields.map(([key, value]) => [device ? key.replace(/^content\./, "") : key, value])
  const field = (name) => entries.filter(([key]) => key === name || key.startsWith(`${name}[`)).map(([, value]) => value)
  const program = field("program")[0]
  if (program) analyzeArgv([program, ...field("args")], EMPTY_SEGMENT, ctx, new Map())
  const host = action === "ssh" ? field("host")[0] ?? field("hostname")[0] : undefined
  for (const [key, value] of entries) {
    const leaf = key.split(".").pop().replace(/\[\d+\]$/, "")
    if (!EXEC_KEYS.has(leaf)) continue
    if (host) analyzeArgv(["ssh", host, value], EMPTY_SEGMENT, ctx, new Map())
    else analyzeText(value, ctx)
  }
}

// Returns { decision: "deny", reasonCode, message } for a hard deny,
// { decision: "infra", summary } for an infrastructure mutation that must fail
// closed, or null. `req` is the normalized permission request.
// `aliases` (Map or object) replaces the aliases parsed from the zsh rc file.
export function guardPermission(req, { directory, env = process.env, aliases } = {}) {
  const state = {
    aliases: aliases === undefined ? loadAliases(env) : aliases instanceof Map ? aliases : new Map(Object.entries(aliases)),
    env,
    protectedTargets: parseProtectedTargets(env.OMP_JEV_PROTECTED_TARGETS),
    trustedTargets: parseTrustedTargets(env.OMP_JEV_TRUSTED_TARGETS),
    budget: MAX_BUDGET,
    files: 0,
    deny: null,
    infra: [],
    trusted: [],
    truncated: false,
    repoRoots: new Map(),
    virtualFiles: new Map(),
  }
  const action = String(req.action).toLowerCase()
  const ctx = { state, dir: directory || undefined, vars: new Map(), taint: null, remote: null, depth: 0 }
  const [primary, ...others] = req.resources
  if (action === "bash") {
    const fields = parseFields(others)
    const cwd = fields.find(([key]) => key === "cwd")?.[1]
    if (cwd) ctx.dir = resolvePath(cwd, ctx)
    for (const [key, value] of fields) if (key.startsWith("env.")) ctx.vars.set(key.slice(4), value)
    analyzeText(primary, ctx)
  } else if (action === "eval") {
    const language = parseFields(others).find(([key]) => key === "language")?.[1]
    analyzeCode(primary, ctx, language)
  } else {
    const fields = parseFields(req.resources)
    const path = fields.find(([key]) => key === "path")?.[1] ?? ""
    const device = action === "write" && path.startsWith("xd://")
    if (action === "edit" || (action === "write" && !device)) return null
    analyzeToolArgs(fields, ctx, action, device)
  }
  if (state.deny) return { decision: "deny", ...state.deny }
  if (state.infra.length || state.truncated) {
    const notes = state.truncated ? [...state.infra, "analysis truncated"] : state.infra
    return { decision: "infra", summary: notes.join("; ") }
  }
  if (state.trusted.length) return { decision: "trusted", summary: state.trusted.join("; ") }
  return null
}
