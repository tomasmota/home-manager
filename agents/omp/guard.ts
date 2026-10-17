// Session guard for infrastructure commands, written for a careless agent, not
// an adversarial one. Static always-deny forms (organization-wide GCP changes,
// forge repository/credential loss, force-pushing main) are native omp
// `bash.patterns` in default.nix; this adds what globs cannot express: the
// target environment, the working directory and a per-session switch.
//
//   /guard on (default)  deny prod changes; ask before control changes,
//                        IaC apply/destroy/import/state edits and bulk deletes
//   /guard off           deny prod changes; allow everything else
//
// Commands are read as typed. `bash -c`, eval subprocesses, scripts and
// terminal key text are not inspected. Targets come from --context/--cluster,
// --kube-context, helmfile -e, gcloud --project, IaC -chdir and the working
// directory; a command that names no target is never treated as prod.
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export type Finding = { level: "deny" | "ask"; reason: string };
type Call = { targets: string[]; iac?: boolean; bulk?: boolean };

const ENTRY_TYPE = "dev.tomasmota.guard";

// The loader shares this module with subagent factories, so subagents follow
// the main session's switch.
let guardOn = true;

type Membership = Record<string, true | undefined>;
const words = (text: string): Membership => Object.fromEntries(text.split(" ").map(word => [word, true]));

function environment(target: string): "prod" | "control" | undefined {
  const parts = target.toLowerCase().split(/[^a-z0-9]+/);
  if (parts.some(part => part === "prod" || part === "production" || part === "prd")) return "prod";
  return parts.includes("control") ? "control" : undefined;
}

// Simple commands of a shell line, split on unquoted ; & | ( ) and newlines.
// Quotes are removed; expansions stay literal text.
function simpleCommands(line: string): string[][] {
  const commands: string[][] = [];
  let current: string[] = [];
  let word = "";
  let inWord = false;
  let quote = "";
  const endWord = () => {
    if (inWord) current.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (current.length > 0) commands.push(current);
    current = [];
  };
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === "\\") {
      if (line[i + 1] === "\n") i++;
      else if (i + 1 < line.length) {
        word += line[++i];
        inWord = true;
      }
    } else if (char === "#" && !inWord) {
      while (i + 1 < line.length && line[i + 1] !== "\n") i++;
    } else if (char === " " || char === "\t") {
      endWord();
    } else if (";&|()\n".includes(char)) {
      endCommand();
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

// Interactive aliases from shell/aliases.nix that hide the verb.
const ALIASES: Record<string, string[]> = {
  k: ["kubectl"],
  tfa: ["tofu", "apply"],
  tfat: ["tofu", "apply"],
  tfd: ["tofu", "destroy"],
  tfu: ["tofu", "force-unlock"],
};
const WRAPPERS = words("sudo env command exec nohup time");

function normalize(command: string[]): string[] {
  let rest = command;
  for (;;) {
    while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest = rest.slice(1);
    if (rest.length > 0 && WRAPPERS[rest[0]] === true) rest = rest.slice(1);
    else break;
  }
  if (rest.length === 0) return rest;
  const name = rest[0].slice(rest[0].lastIndexOf("/") + 1);
  return [...(Object.hasOwn(ALIASES, name) ? ALIASES[name] : [name]), ...rest.slice(1)];
}

function flagValues(args: string[], names: string[]): string[] {
  const found: string[] = [];
  args.forEach((arg, index) => {
    for (const name of names) {
      if (arg === name && index + 1 < args.length) found.push(args[index + 1]);
      else if (arg.startsWith(`${name}=`)) found.push(arg.slice(name.length + 1));
    }
  });
  return found;
}

const KUBECTL_MUTATING = words(
  "apply create delete patch replace edit scale autoscale rollout label annotate taint drain cordon uncordon set expose run exec cp debug attach auth",
);
const KUBECTL_READS = words("get describe logs top explain api-resources api-versions version cluster-info diff events wait config port-forward");
// Value flags that may sit between `delete` and the resource kind.
const KUBECTL_VALUE_FLAGS = words("-f --filename -k --kustomize -n --namespace --context --cluster -l --selector -o --output --field-selector --grace-period --timeout");
const BULK_KINDS = /^(?:ns|namespaces?|pvc|persistentvolumeclaims?|pv|persistentvolumes?|crds?|customresourcedefinitions?)(?:[.,/]|$)/;

function kubectl(args: string[]): Call | undefined {
  const at = args.findIndex(arg => KUBECTL_MUTATING[arg] === true || KUBECTL_READS[arg] === true);
  const verb = args[at];
  if (at < 0 || KUBECTL_READS[verb] === true) return undefined;
  const after = args.slice(at + 1);
  const operand = after.find((arg, index) => !arg.startsWith("-") && KUBECTL_VALUE_FLAGS[after[index - 1]] !== true);
  if (verb === "rollout" && (operand === "status" || operand === "history")) return undefined;
  if (verb === "auth" && operand !== "reconcile") return undefined;
  const bulk = verb === "drain" ||
    (verb === "delete" && (after.some(arg => /^(?:--all(?:-namespaces)?(?:=true)?|-A)$/.test(arg)) ||
      (operand ?? "").split(",").some(kind => BULK_KINDS.test(kind))));
  return { targets: flagValues(args, ["--context", "--cluster"]), bulk };
}

const HELM_MUTATING = words("install upgrade uninstall delete del rollback test");
const HELM_READS = words("list ls status history get show template lint search repo dependency dep plugin package pull push registry version env completion create verify inspect");
const HELMFILE_MUTATING = words("apply sync destroy delete");
const HELMFILE_READS = words("diff template lint list status build deps repos fetch write-values show-dag version init cache");
const HELM_BULK = words("uninstall delete del");
const HELMFILE_BULK = words("destroy delete");

function release(args: string[], mutating: Membership, reads: Membership, bulk: Membership, targets: string[]): Call | undefined {
  const verb = args.find(arg => mutating[arg] === true || reads[arg] === true);
  if (!verb || reads[verb] === true) return undefined;
  return { targets: flagValues(args, targets), bulk: bulk[verb] === true };
}

const IAC_MUTATING = words("apply destroy import taint untaint force-unlock refresh");
const IAC_STATE_MUTATING = words("rm mv push replace-provider");

function iac(args: string[], dir: string): Call | undefined {
  const mutating = args.some((arg, index) => IAC_MUTATING[arg] === true || (arg === "state" && IAC_STATE_MUTATING[args[index + 1]] === true));
  if (!mutating) return undefined;
  const chdir = flagValues(args, ["-chdir", "--chdir", "--terragrunt-working-dir", "--working-dir"]).at(-1);
  return { targets: [chdir ? resolve(dir, expandHome(chdir)) : dir], iac: true };
}

const GCLOUD_MUTATING =
  /^(?:create|delete|update|set|patch|deploy|resize|enable|disable|reset|start|stop|restart|suspend|resume|undelete|move|attach|detach|import|rollback|ssh|scp|(?:add|remove|set|delete|update|create)-[a-z-]+)$/;

function gcloud(args: string[]): Call | undefined {
  if (!args.some(arg => !arg.startsWith("-") && GCLOUD_MUTATING.test(arg))) return undefined;
  return { targets: flagValues(args, ["--project"]) };
}

function classify(command: string[], dir: string): Call | undefined {
  const [tool, ...args] = command;
  switch (tool) {
    case "kubectl":
      return kubectl(args);
    case "helm":
      return release(args, HELM_MUTATING, HELM_READS, HELM_BULK, ["--kube-context"]);
    case "helmfile":
      return release(args, HELMFILE_MUTATING, HELMFILE_READS, HELMFILE_BULK, ["--kube-context", "-e", "--environment"]);
    case "tofu":
    case "terraform":
    case "terragrunt":
      return iac(args, dir);
    case "gcloud":
      return gcloud(args);
    default:
      return undefined;
  }
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? `${process.env.HOME || homedir()}${path.slice(1)}` : path;
}

export function check(line: string, cwd: string, on: boolean): Finding | undefined {
  let dir = cwd;
  const asks: string[] = [];
  for (const raw of simpleCommands(line)) {
    const command = normalize(raw);
    if (command[0] === "cd") {
      if (command[1] !== "-") dir = resolve(dir, expandHome(command[1] ?? "~"));
      continue;
    }
    const call = classify(command, dir);
    if (!call) continue;
    const shown = `\`${command.join(" ").slice(0, 200)}\``;
    const environments = call.targets.map(environment);
    if (environments.includes("prod")) return { level: "deny", reason: `${shown} changes production` };
    if (!on) continue;
    if (environments.includes("control")) asks.push(`${shown} changes the control environment`);
    else if (call.iac) asks.push(`${shown} applies or rewrites infrastructure state`);
    else if (call.bulk) asks.push(`${shown} deletes in bulk`);
  }
  return asks.length > 0 ? { level: "ask", reason: asks.join("; ") } : undefined;
}

export default function guard(pi: ExtensionAPI): void {
  const show = (ctx: ExtensionContext) => ctx.ui.setStatus("guard", guardOn ? undefined : "guard off");

  // The switch recorded on the current branch; undefined when never set.
  const recorded = (ctx: ExtensionContext): boolean | undefined => {
    let on: boolean | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) on = (entry.data as { on?: boolean } | undefined)?.on !== false;
    }
    return on;
  };

  // Every session starts guarded unless it recorded `/guard off`, `/new` included.
  const restore = (ctx: ExtensionContext) => {
    if (ctx.agent?.kind !== "main") return;
    guardOn = recorded(ctx) ?? true;
    show(ctx);
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_switch", (_event, ctx) => restore(ctx));
  pi.on("session_branch", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));

  pi.registerCommand("guard", {
    description: "Infrastructure guard for this session: /guard [on|off]",
    getArgumentCompletions: prefix => {
      const items = [
        { value: "on", label: "on", description: "Ask before control changes, IaC applies and bulk deletes" },
        { value: "off", label: "off", description: "Allow them; production changes stay denied" },
      ].filter(item => item.value.startsWith(prefix.trim().toLowerCase()));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const choice = args.trim().toLowerCase();
      if (choice !== "" && choice !== "on" && choice !== "off") {
        ctx.ui.notify("Usage: /guard [on|off]", "error");
        return;
      }
      if (choice !== "" && (choice === "on") !== guardOn) {
        guardOn = choice === "on";
        pi.appendEntry(ENTRY_TYPE, { on: guardOn });
        show(ctx);
      }
      ctx.ui.notify(guardOn
        ? "Guard on: production changes are denied; control changes, IaC applies and bulk deletes ask first."
        : "Guard off for this session: only production changes and the static denies are blocked.", "info");
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const input = event.input as { command?: unknown; cwd?: unknown };
    if (typeof input.command !== "string") return undefined;
    const cwd = typeof input.cwd === "string" && !input.cwd.includes("://") ? resolve(ctx.cwd, expandHome(input.cwd)) : ctx.cwd;
    const finding = check(input.command, cwd, guardOn);
    if (!finding) return undefined;
    if (finding.level === "deny") {
      return { block: true, reason: `Guard: ${finding.reason}. Do not retry or work around this; ask the user to run it themselves.` };
    }
    if (!ctx.hasUI || ctx.agent?.kind === "sub") {
      return { block: true, reason: `Guard: ${finding.reason}, which needs the user's approval and none is possible here. Ask the user.` };
    }
    const approved = await ctx.ui.confirm("Guard: allow this infrastructure change?", `${finding.reason}\n\n${input.command}`.slice(0, 2000));
    return approved ? undefined : { block: true, reason: "Guard: the user rejected this command." };
  });
}
