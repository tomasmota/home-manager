import assert from "node:assert/strict";
import test from "node:test";
import guard, { check } from "./guard.ts";

const cwd = "/work/infra/live/dev";

test("production mutations are denied in both modes, including IaC working directories", () => {
  const cases = [
    ["kubectl --context prod apply -f app.yaml", cwd],
    ["kubectl delete pod test --context=prod", cwd],
    ["/usr/bin/kubectl --cluster=production patch deploy app -p '{}'", cwd],
    ["k --context prod rollout restart deploy app", cwd],
    ["kubectl --context prod auth reconcile -f roles.yaml", cwd],
    ["helm --kube-context prod upgrade app ./chart", cwd],
    ["helmfile -e prod sync", cwd],
    ["gcloud --project=example-prod-core compute instances delete vm", cwd],
    ["gcloud compute instances stop vm --project example-production-core", cwd],
    ["tofu apply", "/work/infra/live/prod/app"],
    ["terraform -chdir=../prod apply", cwd],
    ["terragrunt run --all -- destroy", "/work/infra/live/prd"],
    ["cd ../prod && tofu state rm app.test", cwd],
    ["tofu -chdir='../prod with spaces' apply", cwd],
    ["tfa", "/work/infra/live/prod"],
    ["kubectl --context control apply -f a; kubectl --context prod delete pod b", cwd],
  ];
  for (const [command, dir] of cases) {
    for (const on of [true, false]) assert.equal(check(command, dir, on)?.level, "deny", `${command}; ${dir}; on=${on}`);
  }
});

test("control, IaC and bulk disruption ask only while guarded", () => {
  for (const command of [
    "kubectl --context control apply -f app.yaml",
    "gcloud --project=example-control-core compute instances create vm",
    "helm --kube-context control upgrade app ./chart",
    "tofu apply", "tofu destroy", "terraform import module.app id",
    "terragrunt run-all apply", "tofu state mv old new", "tofu refresh", "tfa", "tfat", "tfd", "tfu",
    "kubectl --context dev delete namespace test",
    "kubectl delete pod --all", "kubectl delete -n test pvc data",
    "kubectl delete pod --all=true", "kubectl delete pod,pvc agent-test",
    "kubectl --context playground delete crd examples.test",
    "kubectl delete pod -A test", "kubectl drain node1",
    "helm uninstall test", "helmfile destroy",
  ]) {
    assert.equal(check(command, cwd, true)?.level, "ask", command);
    assert.equal(check(command, cwd, false), undefined, command);
  }
});

test("ordinary operations and production reads stay allowed; prose and filenames aren't targets", () => {
  for (const command of [
    "kubectl --context prod get pods", "kubectl --context prod logs pod/test",
    "kubectl --context prod rollout status deploy/app",
    "kubectl --context prod auth can-i delete pods",
    "helm --kube-context prod list", "helmfile -e prod diff",
    "gcloud --project=example-prod-core compute instances list",
    "tofu -chdir=../prod plan", "tofu state show module.app", "tofu plan -var 'operation=apply'",
    "kubectl --context dev apply -f production.yaml",
    "kubectl --context dev delete pod agent-test",
    "kubectl --context dev delete pod agent-test --all=false",
    "kubectl --context playground create namespace test",
    "kubectl apply -f app.yaml", // Deliberately no implicit-context lookup.
    "git push -u origin feature/test", "git config user.name Example",
    "git commit -m 'tofu apply; kubectl --context prod delete ns test'",
    "glab mr create --title 'delete dead feature flag'",
    "echo 'kubectl --context prod delete ns test'",
    "tofu plan # tofu apply\ntrue",
  ]) {
    for (const on of [true, false]) assert.equal(check(command, cwd, on), undefined, `${command}; on=${on}`);
  }
});

function host(entries = []) {
  const handlers = {};
  let command;
  const notices = [];
  const pi = {
    on(name, handler) { handlers[name] = handler; },
    registerCommand(name, definition) { command = definition.handler; },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  };
  const context = {
    cwd, hasUI: true, agent: { kind: "main" },
    sessionManager: { getBranch: () => entries },
    ui: { setStatus() {}, notify(message) { notices.push(message); }, confirm: async () => false },
  };
  guard(pi);
  return { handlers, command, context, entries, notices };
}

test("session choice persists on resume, new sessions reset, and children share the switch", async () => {
  const parent = host();
  await parent.handlers.session_start({}, parent.context);
  const call = { toolName: "bash", input: { command: "tofu apply" } };
  const child = host();
  child.context.agent = { kind: "sub" };
  child.context.hasUI = false;
  await child.handlers.session_start({}, child.context);
  assert.equal((await child.handlers.tool_call(call, child.context))?.block, true);
  child.context.hasUI = true;
  child.context.ui.confirm = async () => true;
  assert.equal((await child.handlers.tool_call(call, child.context))?.block, true);
  await parent.command("off", parent.context);
  assert.equal(await child.handlers.tool_call(call, child.context), undefined);
  assert.equal((await child.handlers.tool_call({ toolName: "bash", input: { command: "tofu apply", cwd: "../prod" } }, child.context))?.block, true);

  const resumed = host(parent.entries);
  await resumed.handlers.session_start({}, resumed.context);
  assert.equal(await resumed.handlers.tool_call(call, resumed.context), undefined);
  await resumed.command("on", resumed.context);
  assert.equal((await resumed.handlers.tool_call(call, resumed.context))?.block, true);
  resumed.context.ui.confirm = async () => true;
  assert.equal(await resumed.handlers.tool_call(call, resumed.context), undefined);

  const fresh = host();
  await fresh.handlers.session_switch({ reason: "new" }, fresh.context);
  assert.equal((await child.handlers.tool_call(call, child.context))?.block, true);
});
