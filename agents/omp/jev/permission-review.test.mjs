import assert from "node:assert/strict"
import test, { after } from "node:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionEvaluator } from "./permission-review.js"
import { guardPermission, parseAliases } from "./infra-guard.js"

// Hermetic environment: no real kubeconfig, cloud profiles, zsh aliases or reviewer config.
const root = mkdtempSync(join(tmpdir(), "permission-review-"))
const home = join(root, "home")
const auditDir = join(root, "audit")
mkdirSync(home)
for (const name of [
  "KUBECONFIG", "HELM_KUBECONTEXT", "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "CLOUDSDK_CONFIG", "CLOUDSDK_CORE_PROJECT",
  "CLOUDSDK_ACTIVE_CONFIG_NAME", "GOOGLE_CLOUD_PROJECT", "AZURE_CONFIG_DIR", "PGHOST", "PGSERVICE", "DATABASE_URL",
  "MYSQL_HOST", "TF_WORKSPACE", "TF_CLI_ARGS", "TF_CLI_ARGS_apply", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG",
  "OMP_REVIEW_DIR", "OMP_JEV_PROTECTED_TARGETS", "OMP_JEV_ON_EXHAUSTION", "OMP_JEV_FALLBACK_MODELS",
  "OMP_JEV_PRODUCTION_MIN", "ZDOTDIR",
]) delete process.env[name]
process.env.HOME = home
process.env.OMP_JEV_DEBUG = join(auditDir, "decisions.jsonl")
after(() => rmSync(root, { recursive: true, force: true }))

const verdict = ({ danger = 0, blast = 0, purpose = 0.99, production = 0.01, category = "routine_or_scoped" } = {}) => ({
  model: "jev-stub",
  answers: {
    dangerousness: { type: "score", score: danger, confidence: 0.99 },
    blast_radius: { type: "score", score: blast, confidence: 0.99 },
    plausible_dev_purpose: { type: "noul", noul: purpose },
    production_impact: { type: "noul", noul: production },
    risk_category: { type: "choice", choice: category, confidence: 0.99 },
  },
})

function stubs({ jev = "safe", fallback = "allow" } = {}) {
  const calls = { jev: 0, fallback: 0, prompts: [] }
  const requestJev = async () => {
    calls.jev++
    if (jev === "down") throw new Error("Jev offline (stub)")
    return jev === "safe" ? verdict() : verdict(jev)
  }
  const generate = {
    async text({ prompt }) {
      calls.fallback++
      calls.prompts.push(prompt)
      if (fallback === "down") throw new Error("fallback offline (stub)")
      return { text: JSON.stringify({ decision: fallback, reasonCode: `stub_${fallback}`, reason: "Stub decision." }) }
    },
  }
  return { calls, requestJev, generate }
}

function lastAudit() {
  const files = readdirSync(auditDir).filter((name) => name.endsWith(".jsonl")).sort()
  const lines = files.flatMap((name) => readFileSync(join(auditDir, name), "utf8").trim().split("\n"))
  return JSON.parse(lines.at(-1))
}

async function review(action, resources, { directory = "/repo", ...options } = {}) {
  const { calls, requestJev, generate } = stubs(options)
  const event = { effect: "ask", sessionID: "test", action, resources }
  await createPermissionEvaluator({ generate, directory, requestJev })(event)
  return { effect: event.effect, message: event.message, audit: lastAudit(), calls }
}

function withEnv(name, value, run) {
  const previous = process.env[name]
  process.env[name] = value
  return Promise.resolve(run()).finally(() => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  })
}

const bash = (command, directory) => ({ action: "bash", resources: [command], directory })
const py = (code) => ({ action: "eval", resources: [code, "language: py"] })

const HARD_DENY = [
  bash("kubectl --context prod delete namespace payments"),
  bash("kubectl --context=prod -n payments delete deploy api"),
  bash("kubectl delete namespace payments"),
  bash("kubectl --context mgmt delete ns payments"),
  bash("KUBECONFIG=~/.kube/prod.yaml kubectl delete pod x"),
  bash("cd /tmp && env FOO=1 /usr/local/bin/kubectl --context prod drain node-1"),
  bash("kubectl --context prod scale deploy api --replicas=0"),
  bash("kubectl --context prod apply -f m.yaml"),
  bash("kubectl --context prod rollout restart deploy/api"),
  bash("kubectl --context prod exec -it api-0 -- sh"),
  bash("helm --kube-context prod uninstall api"),
  bash("helm uninstall api"),
  bash('bash -c "kubectl --context prod delete ns payments"'),
  bash("ssh bastion 'kubectl --context prod delete ns x'"),
  bash("tmux send-keys -t %1 'kubectl --context prod delete ns payments' Enter"),
  py('import subprocess; subprocess.run(["kubectl", "--context", "prod", "delete", "ns", "payments"])'),
  bash("tofu destroy"),
  bash("terraform apply -destroy"),
  bash("tofu -chdir=live/prod/app apply"),
  bash("tofu apply", "/repo/live/prod/app"),
  bash("tofu state rm aws_db.main", "/repo/live/prod/app"),
  bash("gcloud --project acme-prod container clusters delete main"),
  bash("gcloud container clusters delete main"),
  bash("gsutil -m rm -r gs://acme-prod-backups"),
  bash("aws s3 rb s3://prod-customer-backups --force"),
  bash("aws --profile prod ec2 terminate-instances --instance-ids i-1"),
  bash('psql "postgres://app@db.prod.internal/app" -c "DROP TABLE users"'),
  bash("redis-cli -h redis-prod FLUSHALL"),
  bash("git push --force origin main"),
]

for (const item of HARD_DENY) {
  test(`hard deny regardless of reviewers: ${item.resources[0]}`, async () => {
    for (const jev of ["safe", "down"]) {
      const result = await review(item.action, item.resources, { directory: item.directory, jev, fallback: "allow" })
      assert.equal(result.effect, "deny", `jev=${jev}`)
      assert.equal(result.audit.source, "policy")
      assert.match(result.audit.reasonCode, /^(?:prod_mutation|unscoped_destructive|protected_branch_rewrite)$/)
      assert.match(result.message, /Do not retry.*ask the user to run it themselves/s)
      assert.equal(result.calls.jev, 0)
      assert.equal(result.calls.fallback, 0)
    }
  })
}

test("protected targets from OMP_JEV_PROTECTED_TARGETS are production", async () => {
  const before = await review("bash", ["kubectl --context mgmt apply -f m.yaml"])
  assert.equal(before.effect, "allow")
  await withEnv("OMP_JEV_PROTECTED_TARGETS", "mgmt, acme-core", async () => {
    for (const jev of ["safe", "down"]) {
      const result = await review("bash", ["kubectl --context mgmt apply -f m.yaml"], { jev })
      assert.equal(result.effect, "deny")
      assert.equal(result.audit.source, "policy")
      assert.equal(result.audit.reasonCode, "prod_mutation")
      assert.match(result.message, /protected target "mgmt"/)
    }
  })
})

const NOT_HARD_DENIED = [
  bash("kubectl --context prod get pods -A"),
  bash("kubectl --context prod describe deploy api"),
  bash("kubectl --context prod logs deploy/api --since=1h"),
  bash("kubectl --context prod auth can-i delete pods"),
  bash("kubectl --context prod diff -f m.yaml"),
  bash("kubectl config get-contexts"),
  bash("kubectl --context dev delete pod api-0"),
  bash("kubectl --context playground apply -f m.yaml"),
  bash("tofu plan", "/repo/live/prod/app"),
  bash("tofu -chdir=live/prod/app plan"),
  bash("terramate run -- tofu plan"),
  bash("gcloud --project acme-prod compute instances list"),
  bash("rm -rf node_modules dist"),
  bash("git status"),
  bash("git push origin feature/x"),
  bash("npm run build"),
  bash("echo product"),
  bash("grep -r prod src/"),
  bash("cat production.log"),
  bash("node --test agents/omp/jev/permission-review.test.mjs"),
  { action: "write", resources: ["path: notes.md", "content: kubectl --context prod delete ns payments"] },
]

for (const item of NOT_HARD_DENIED) {
  test(`not hard-denied: ${item.resources.join(" | ")}`, async () => {
    const result = await review(item.action, item.resources, { directory: item.directory })
    assert.equal(result.effect, "allow")
    assert.notEqual(result.audit.source, "policy")
    assert.equal(result.calls.jev, 1)
  })
}

test("flagged infrastructure mutations fail closed when reviewers are unavailable", async () => {
  for (const setting of [undefined, "allow", "manual"]) {
    const run = () => review("bash", ["kubectl --context dev delete ns x"], { jev: "down", fallback: "down" })
    const result = setting ? await withEnv("OMP_JEV_ON_EXHAUSTION", setting, run) : await run()
    assert.equal(result.effect, "deny", `OMP_JEV_ON_EXHAUSTION=${setting}`)
    assert.equal(result.audit.source, "exhaustion")
    assert.equal(result.audit.reasonCode, "reviewers_unavailable_infra")
    assert.match(result.audit.infraMutation, /kube context "dev"/)
    assert.match(result.message, /ask the user to run it themselves/)
  }
  const reviewed = await review("bash", ["kubectl --context dev delete ns x"])
  assert.equal(reviewed.effect, "allow")
  assert.equal(reviewed.audit.source, "jev")
})

test("fallback sees the trusted infrastructure pre-check", async () => {
  const result = await review("bash", ["helm upgrade --install api ./chart"], { jev: "down", fallback: "allow" })
  assert.equal(result.effect, "allow")
  assert.equal(result.audit.source, "llm-fallback")
  assert.match(result.calls.prompts[0], /Trusted deterministic pre-check: this action mutates infrastructure: helm upgrade/)
  assert.match(result.calls.prompts[0], /Treat an unknown or unspecified infrastructure target as production/)
})

test("ordinary development still follows OMP_JEV_ON_EXHAUSTION", async () => {
  const fallbackOpen = await review("bash", ["npm run build"], { jev: "down", fallback: "down" })
  assert.equal(fallbackOpen.effect, "allow")
  assert.equal(fallbackOpen.audit.reasonCode, "reviewers_unavailable_fail_open")
  const manual = await withEnv("OMP_JEV_ON_EXHAUSTION", "manual", () => review("bash", ["npm run build"], { jev: "down", fallback: "down" }))
  assert.equal(manual.effect, "ask")
  const closed = await withEnv("OMP_JEV_ON_EXHAUSTION", "deny", () => review("bash", ["npm run build"], { jev: "down", fallback: "down" }))
  assert.equal(closed.effect, "deny")
  assert.equal(closed.audit.reasonCode, "reviewers_unavailable")
})

test("Jev production impact denies or escalates to the fallback", async () => {
  const denied = await review("bash", ["make deploy"], { jev: { production: 0.9 } })
  assert.equal(denied.effect, "deny")
  assert.equal(denied.audit.reasonCode, "jev_production_impact")
  assert.equal(denied.calls.fallback, 0)
  const borderline = await review("bash", ["make deploy"], { jev: { production: 0.6 }, fallback: "deny" })
  assert.equal(borderline.effect, "deny")
  assert.equal(borderline.audit.source, "llm-fallback")
  const quiet = await review("bash", ["make deploy"], { jev: { production: 0.3 } })
  assert.equal(quiet.effect, "allow")
})

// ---------------------------------------------------------------------------
// Guard unit checks: no reviewers involved.

const guard = (action, resources, directory = "/repo", env = {}) =>
  guardPermission({ action, resources }, { directory, env: { HOME: home, ...env } })
const guardBash = (command, directory) => guard("bash", [command], directory)

test("guard sees through wrappers, shells, eval and remote indirection", () => {
  for (const command of [
    "sudo -u kube kubectl --context prod delete ns x",
    "timeout 30 kubectl delete ns x",
    "kubectl get ns -o name | xargs kubectl delete",
    "watch -n 5 kubectl --context prod delete pod x",
    "find . -name '*.yaml' -exec kubectl delete -f {} \\;",
    "echo 'kubectl --context prod delete ns x' | bash",
    "bash <<'EOF'\nkubectl --context prod delete ns x\nEOF",
    "sh -lc 'cd /tmp; kubectl delete ns x'",
    "eval 'kubectl delete ns x'",
    "env -S 'kubectl delete ns x'",
    "CTX=prod; kubectl --context $CTX apply -f x",
    "aws-vault exec prod -- aws s3 rm s3://bucket/x",
    "op run -- kubectl --context prod apply -f x",
    "python3 -c 'import os; os.system(\"kubectl --context prod delete ns x\")'",
    "node -e 'require(\"child_process\").execSync(\"kubectl delete ns x\")'",
    "function f { kubectl delete ns x; }",
    "ssh prod-db 'sudo systemctl restart postgres'",
    "ssh prod-db",
    "ssh -N -L 5432:db:5432 prod-bastion",
    "rsync -av dist/ prod-web:/srv/www",
    "kubectl config use-context prod",
    "gcloud --project acme-prod compute ssh vm-1 --command 'cat /etc/hosts'",
    "terraform apply -auto-approve",
    "yes | terraform apply",
    "terramate run -- tofu apply -auto-approve",
    "psql -c 'DROP TABLE users'",
    "psql postgres://db.prod/app -c 'update users set x=1 where id=1'",
    "git push origin :main",
    "git push origin +release/1.2",
    "gh repo delete acme/x --yes",
    "make deploy ENV=prod",
    "npm run migrate:production",
    "python3 manage.py migrate --settings=config.settings.production",
  ]) assert.equal(guardBash(command)?.decision, "deny", command)
  assert.equal(guard("eval", ["await Bun.$`kubectl --context prod delete ns ${ns}`", "language: js"])?.decision, "deny")
  assert.equal(guard("eval", ["require('child_process').execSync('helm uninstall api')", "language: js"])?.decision, "deny")
})

test("guard leaves read-only production work and text mentions alone", () => {
  for (const command of [
    "ssh prod-db 'tail -n 50 /var/log/syslog'",
    "psql postgres://db.prod/app -c 'select count(*) from users'",
    "redis-cli -h redis-prod GET key",
    "aws s3 cp s3://prod-bucket/x ./x",
    "kubectl delete --dry-run=server ns x",
    "helm template api ./chart -f values-prod.yaml",
    "ansible-playbook -i inventories/prod site.yml --check",
    "git commit -m 'kubectl --context prod delete ns x'",
    "gh pr create --title t --body 'kubectl --context prod delete ns x'",
    "grep -rn 'kubectl delete' docs/",
    "NODE_ENV=production node server.js",
    "npm install --production",
    "docker build -t api:prod .",
    "go test ./... -run TestDeploy",
  ]) assert.notEqual(guardBash(command)?.decision, "deny", command)
  assert.equal(guard("edit", ["path: a.md", "new_text: kubectl --context prod delete ns x"]), null)
  assert.equal(guard("write", ["path: xd://mcp__confluence_createjiraissue", "content.description: kubectl --context prod delete ns x"]), null)
})

test("guard inspects executable xd:// device arguments", () => {
  const result = guard("write", [
    "path: xd://debug", "content.action: launch", "content.program: /usr/local/bin/kubectl",
    "content.args[0]: --context", "content.args[1]: prod", "content.args[2]: delete", "content.args[3]: ns", "content.args[4]: x",
  ])
  assert.equal(result?.decision, "deny")
})

test("guard reads local shell scripts but never node or python files", () => {
  const dir = mkdtempSync(join(root, "scripts-"))
  writeFileSync(join(dir, "deploy.sh"), "#!/usr/bin/env bash\nset -e\nkubectl --context prod delete ns payments\n")
  writeFileSync(join(dir, "tool.mjs"), "#!/usr/bin/env node\n// kubectl --context prod delete ns payments\n")
  writeFileSync(join(dir, "tool.py"), "import subprocess\nsubprocess.run(['kubectl', 'delete', 'ns', 'x'])\n")
  for (const command of ["bash deploy.sh", "./deploy.sh", "source deploy.sh", "printf 'kubectl delete ns x\\n' > t.sh && bash t.sh"]) {
    assert.equal(guardBash(command, dir)?.decision, "deny", command)
  }
  for (const command of ["node tool.mjs", "python3 tool.py", "./tool.mjs"]) assert.equal(guardBash(command, dir), null, command)
})

test("guard resolves implicit kube contexts only toward production", () => {
  mkdirSync(join(home, ".kube"), { recursive: true })
  try {
    writeFileSync(join(home, ".kube", "config"), "apiVersion: v1\ncurrent-context: gke_acme-prod_europe_main\n")
    assert.equal(guardBash("kubectl apply -f x.yaml")?.reasonCode, "prod_mutation")
    assert.equal(guardBash("kubectl get pods"), null)
    writeFileSync(join(home, ".kube", "config"), "apiVersion: v1\ncurrent-context: kind-dev\n")
    assert.equal(guardBash("kubectl apply -f x.yaml")?.decision, "infra")
    assert.equal(guardBash("kubectl delete pod x")?.reasonCode, "unscoped_destructive")
  } finally {
    rmSync(join(home, ".kube"), { recursive: true, force: true })
  }
})

test("IaC directories count as non-production only below a repository root", () => {
  const repo = mkdtempSync(join(root, "repo-"))
  mkdirSync(join(repo, ".git"))
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feature/x\n")
  mkdirSync(join(repo, "live", "dev", "app"), { recursive: true })
  const outside = join(root, "dev", "infra")
  mkdirSync(outside, { recursive: true })
  assert.equal(guardBash("tofu destroy", join(repo, "live", "dev", "app"))?.decision, "infra")
  assert.equal(guardBash("tofu -chdir=live/dev/app destroy", repo)?.decision, "infra")
  assert.equal(guardBash("tofu destroy", outside)?.reasonCode, "unscoped_destructive")
  assert.equal(guardBash("git push -f", repo), null)
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n")
  assert.equal(guardBash("git push -f", repo)?.reasonCode, "protected_branch_rewrite")
})

// ---------------------------------------------------------------------------
// Interactive-shell aliases. Sources are injected; the real zshrc is never read.

const ALIASES = { k: "kubectl", tfd: "tofu destroy", tfa: "tofu apply --parallelism=30", loopa: "loopb x", loopb: "loopa y" }
const PROD_DIR = "/work/infra/live/prod/app"
const aliased = (command, directory = "/repo") =>
  guardPermission({ action: "bash", resources: [command] }, { directory, env: { HOME: home }, aliases: ALIASES })

test("aliases relayed into interactive shells are expanded", () => {
  for (const [command, directory] of [
    ["tmux send-keys -t %3 'k --context prod delete ns payments' Enter"],
    ["tern send 141733920867 text 'k --context prod delete ns payments'"],
    ["zsh -ic 'k --context prod delete ns payments'"],
    ["zsh -ic tfd", PROD_DIR],
    ["tmux send-keys -t %3 tfa Enter", PROD_DIR],
    ["tern send 141733920867 keys t f d Enter", PROD_DIR],
  ]) assert.equal(aliased(command, directory)?.decision, "deny", command)
  assert.equal(aliased("tern send 141733920867 text 'k --context prod get pods'"), null)
  assert.equal(aliased("tmux send-keys -t %1 C-c"), null)
  assert.equal(aliased("loopa"), null)
  assert.equal(guardPermission({ action: "bash", resources: ["zsh -ic tfd"] }, { directory: PROD_DIR, env: { HOME: home }, aliases: {} }), null)
})

test("pane directories can mark production but never non-production", () => {
  const repo = mkdtempSync(join(root, "pane-"))
  mkdirSync(join(repo, ".git"))
  const dev = join(repo, "live", "dev", "app")
  mkdirSync(dev, { recursive: true })
  assert.equal(aliased("tofu destroy", dev)?.decision, "infra")
  assert.equal(aliased("tmux send-keys -t %3 'tofu destroy' Enter", dev)?.reasonCode, "unscoped_destructive")
  assert.equal(aliased(`tmux send-keys -t %3 'cd ${dev} && tofu destroy' Enter`, dev)?.decision, "infra")
})

test("aliases come from the rendered zsh rc file, with shell quoting", async () => {
  const zdotdir = mkdtempSync(join(root, "zdotdir-"))
  const rc = join(zdotdir, ".zshrc")
  writeFileSync(rc, [
    "# home-manager renders shellAliases like this",
    "alias -- k=kubectl",
    "alias -- tfd='tofu destroy'",
    "alias -- t='tree -I '\\''node_modules|dist'\\'''",
    "alias -- hmcd='cd /tmp \\",
    "  && echo done'",
    "alias -s md=nvim",
    "",
  ].join("\n"))
  const parsed = parseAliases(readFileSync(rc, "utf8"))
  assert.deepEqual(Object.fromEntries(parsed), {
    k: "kubectl",
    tfd: "tofu destroy",
    t: "tree -I 'node_modules|dist'",
    hmcd: "cd /tmp \\\n  && echo done",
  })
  const fromRc = (command, env) => guardPermission({ action: "bash", resources: [command] }, { directory: PROD_DIR, env })
  assert.equal(fromRc("zsh -ic tfd", { HOME: home, ZDOTDIR: zdotdir })?.reasonCode, "prod_mutation")
  assert.equal(fromRc("zsh -ic tfd", { HOME: home }), null)
  writeFileSync(rc, "alias -- tfd='tofu destroy'\nalias -- tfa='tofu apply'\n")
  assert.equal(fromRc("tmux send-keys -t %3 tfa Enter", { HOME: home, ZDOTDIR: zdotdir })?.reasonCode, "prod_mutation")

  // Through the evaluator, with Jev both safe and down.
  await withEnv("ZDOTDIR", zdotdir, async () => {
    for (const jev of ["safe", "down"]) {
      const result = await review("bash", ["zsh -ic tfd"], { directory: PROD_DIR, jev })
      assert.equal(result.effect, "deny")
      assert.equal(result.audit.source, "policy")
    }
  })
})
