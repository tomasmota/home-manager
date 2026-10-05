import { test } from "node:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { execFileSync } from "node:child_process"

const root = resolve(import.meta.dirname, "../../..")
const ompDir = join(root, "agents", "omp")
const read = (p) => readFileSync(join(ompDir, p), "utf8")

const parseFrontmatter = (text) => {
  if (!text.startsWith("---\n")) throw new Error("missing frontmatter")
  const end = text.indexOf("\n---\n", 4)
  if (end < 0) throw new Error("unterminated frontmatter")
  const out = {}
  for (const line of text.slice(4, end).split("\n")) {
    const m = /^([a-zA-Z-]+):\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "")
  }
  return out
}

test("mcp.json keeps the workstation server definitions", () => {
  const mcp = JSON.parse(read("mcp.json"))
  const servers = mcp.mcpServers
  const chrome = servers["chrome-devtools"]
  if (chrome.type !== "stdio" || chrome.command !== "npx") throw new Error("chrome-devtools must be the stdio npx server")
  const userDataDir = chrome.args.find((a) => a.startsWith("--user-data-dir="))
  if (userDataDir !== "--user-data-dir=/Users/tomas/Library/Application Support/Vivaldi") {
    throw new Error("chrome-devtools must target the real Vivaldi profile")
  }
  const confluence = servers.confluence
  if (confluence.type !== "http" || confluence.url !== "https://mcp.atlassian.com/v1/mcp/authv2") {
    throw new Error("confluence endpoint drifted from the OpenCode setup")
  }
  for (const disabled of ["opentofu", "incident-io"]) {
    if (servers[disabled]) throw new Error(`${disabled} was disabled in OpenCode and must not be ported`)
  }
})

test("custom agents are exactly the profiles without a bundled equivalent", () => {
  const files = readdirSync(join(ompDir, "agents")).filter((f) => f.endsWith(".md")).sort()
  if (JSON.stringify(files) !== JSON.stringify(["coder.md", "deep.md", "terminal.md"])) {
    throw new Error(`unexpected custom agent set: ${files.join(", ")} (general/quick/explore/reviewer use bundled agents)`)
  }
  const reserved = ["main", "sub", "task", "sonic", "scout", "reviewer", "security-reviewer"]
  for (const f of files) {
    const fm = parseFrontmatter(read(join("agents", f)))
    for (const key of ["name", "description", "model"]) {
      if (!fm[key]) throw new Error(`${f}: frontmatter must keep name, description and model`)
    }
    if (reserved.includes(fm.name)) throw new Error(`${f}: name ${fm.name} collides with a bundled agent`)
    if (!fm.model.startsWith("@")) throw new Error(`${f}: model must be a modelRoles alias, not a concrete selector`)
  }
})

test("omp is imported only by the Mac home configuration", () => {
  const home = readFileSync(join(root, "home.nix"), "utf8")
  const flake = readFileSync(join(root, "flake.nix"), "utf8")
  if (home.includes("./omp.nix")) throw new Error("shared Home Manager imports must remain omp-free")
  const mac = flake.slice(flake.indexOf("darwinConfigurations ="))
  if (!/extraModules = \[[^\]]*\.\/omp\.nix[^\]]*\];/.test(mac)) throw new Error("Mac must explicitly import omp")
})

test("Jev uses native judgments rather than the chat advisor", () => {
  const module = readFileSync(join(root, "omp.nix"), "utf8")
  if (!module.includes('judge = "typesafe/jev-latest";')) throw new Error("Jev belongs in the judge role")
  if (!module.includes("advisor.enabled = false;")) throw new Error("background advice must remain disabled")
  if (module.includes('advisor = "typesafe/jev-latest"')) throw new Error("Jev cannot emit advisor tool calls")
})

test("smol uses the Inco custom provider with a borrowed OpenCode credential", () => {
  const module = readFileSync(join(root, "omp.nix"), "utf8")
  if (!module.includes('smol = "inco/glm-5.3-flash:fast";')) throw new Error("smol must keep OpenCode's literal Inco id")
  if (module.includes("zai/")) throw new Error("no Z.ai login should remain necessary for GLM")
  if (!module.includes('baseUrl = "https://api.inco.ai/v1";')) throw new Error("Inco chat-completions base URL drifted")
  if (!module.includes('api = "openai-completions";')) throw new Error("Inco must use the OpenAI chat-completions wire")
  if (!module.includes('id = "glm-5.3-flash:fast";')) throw new Error("models.yml must declare the literal model id")
  if (!module.includes('apiKey = "!${incoKey}";')) throw new Error("Inco key must be command-resolved at request time")
  if (!module.includes("opencode api get /api/credential 2>/dev/null")) throw new Error("key must come from OpenCode's credential API")
  if (/sk-inco|INCO_API_KEY/.test(module)) throw new Error("no literal or env-copied Inco credential")
  if (!module.includes('".omp/agent/models.yml".source')) throw new Error("models.yml must be installed by Home Manager")
  for (const role of ['default = "openai-codex/', 'slow = "anthropic/', 'task = "anthropic/', 'coder = "anthropic/']) {
    if (!module.includes(role)) throw new Error(`subscription role moved: ${role}`)
  }
})

test("atomically rewritten MCP config is a writable copy, not a home.file link", () => {
  const module = readFileSync(join(root, "omp.nix"), "utf8")
  if (module.includes('".omp/agent/mcp.json".source')) throw new Error("MCP writer would replace a Home Manager link")
  if (!module.includes('install -m 600 ${./agents/omp/mcp.json} "$HOME/.omp/agent/mcp.json"')) {
    throw new Error("MCP config must be installed as a private writable copy")
  }
  const verify = read("verify.sh")
  if (!verify.includes('realpath "${AGENT_DIR}/${f}"')) throw new Error("verification must resolve Home Manager symlink chains")
})

test("RULES.md is a compact sticky-rules port", () => {
  const rules = read("RULES.md")
  if (rules.length > 4096) throw new Error("sticky rules ride every request; keep them compact")
  for (const phrase of ["credentials", "context-expensive", "low-regret"]) {
    if (!rules.includes(phrase)) throw new Error(`expected the shared-base rule about ${phrase}`)
  }
})

test("config.yml is merged, not overwritten: policy wins, preferences only seed", () => {
  const module = readFileSync(join(root, "omp.nix"), "utf8")
  if (!module.includes("home.activation.ompConfig = lib.mkForce")) throw new Error("upstream whole-file copy must be replaced")
  if (!module.includes("settings = policy;")) throw new Error("programs.omp.settings must carry policy only")
  const policy = module.slice(module.indexOf("  policy = {"), module.indexOf("  preferences = {"))
  for (const key of ["approvalMode", "extensions", "bash.patterns", "auth.broker.url", 'judge = "typesafe/jev-latest"', "smol = [];", "judge = [];"]) {
    if (!policy.includes(key)) throw new Error(`policy must own ${key}`)
  }
  if (/\bdefault = "|theme\./.test(policy)) throw new Error("roles and UI belong to runtime-owned preferences")
})

test("merge-config keeps runtime choices and reapplies policy", () => {
  try { execFileSync("yq", ["--version"]) } catch { return }
  const dir = mkdtempSync(join(tmpdir(), "omp-merge-"))
  const prefs = join(dir, "prefs.yml"), policy = join(dir, "policy.yml"), target = join(dir, "config.yml")
  writeFileSync(prefs, "modelRoles:\n  default: a/one\n  smol: b/two\ntheme:\n  dark: dark-catppuccin\n")
  writeFileSync(policy, "tools:\n  approvalMode: yolo\nmodelRoles:\n  judge: typesafe/jev-latest\nbash:\n  patterns:\n    - {match: \"tofu apply*\", approval: deny}\n")
  writeFileSync(target, "modelRoles:\n  smol: c/three\n  judge: other\ntheme:\n  dark: titanium\ncompaction:\ntools:\n  approvalMode: always-ask\nbash:\n  patterns:\n    - {match: \"ls*\", approval: allow}\n")
  const run = () => execFileSync("bash", [join(ompDir, "merge-config.sh"), prefs, policy, target])
  const get = (expr) => execFileSync("yq", ["-o=json", expr, target], { encoding: "utf8" }).trim()
  run()
  if (get(".modelRoles") !== JSON.stringify({ default: "a/one", smol: "c/three", judge: "typesafe/jev-latest" }, null, 2)) throw new Error(`roles: ${get(".modelRoles")}`)
  if (get(".theme.dark") !== '"titanium"') throw new Error("runtime theme must survive")
  if (get(".tools.approvalMode") !== '"yolo"') throw new Error("policy must win")
  if (get('.bash.patterns | length') !== "1" || get(".bash.patterns[0].approval") !== '"deny"') throw new Error("policy arrays replace runtime arrays")
  if ((statSync(target).mode & 0o777) !== 0o600) throw new Error("config.yml must stay 0600")
  rmSync(target)
  run()
  if (get(".theme.dark") !== '"dark-catppuccin"') throw new Error("missing file must be seeded")
  writeFileSync(target, "foo: [unclosed\n")
  run()
  if (!existsSync(`${target}.invalid`) || get(".modelRoles.default") !== '"a/one"') throw new Error("invalid file must be kept aside and reseeded")
  rmSync(dir, { recursive: true })
})

test("verify.sh stays syntactically valid bash", () => {
  execFileSync("bash", ["-n", join(ompDir, "verify.sh")])
})
