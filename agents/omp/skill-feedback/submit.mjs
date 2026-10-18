#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { resolveSkill } from "./ownership.mjs";
import { identifyProcess, processState } from "./process.mjs";
import { launchWorker } from "./tern.mjs";

const script = fileURLToPath(import.meta.url);
const command = `node ${JSON.stringify(script)}`;
const hash = value => createHash("sha256").update(value).digest("hex");
const requestId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const noteName = /^([0-9a-f]{64})\.json$/;
const lockWaitMs = 10_000;
const successes = new Set(["launched", "recorded", "already-open", "already-reviewed", "awaiting-approval", "complete", "released"]);
const operations = { "awaiting-approval": "await-approval", complete: "complete", released: "release" };
const usage = `Usage: node submit.mjs --skill <SKILL.md|directory> --experience <used|read-only> --from-task <short parent task> --improvement <idea> [--improvement <idea> ...] [--context <feedback context>]

Starts one default-role omp tab per skill in the existing skill-improvements Tern session.
The parent selects relevant improvements from actual use. Reading alone permits only frontmatter activation feedback.
Reports stay private. Repeated calls add notes to the existing request, without sending input.
The worker presents proposals, source path and Git/local status; one explicit approval covers selected edits, verification and Git commit/push.
For a skill not yet tracked in Git, that question discloses that the first commit publishes the skill's entire contents.
Run with omp's bash tool inside Tern. --from-task is a short phrase describing the parent's work, not a session title or ID.
Use a bash tool timeout of 120 seconds: bounded startup checks can exceed a short command timeout.
Describe how the skill was applied and why the requested change helps; never include credentials or raw logs.

Prints one JSON receipt. Exit status 0 only for launched, recorded, already-open, already-reviewed,
awaiting-approval, complete and released. Every other status exits 1 and keeps all notes and claims:
saved-not-launched, launch-uncertain, launch-interrupted, launch-unverifiable, worker-gone,
worker-unverifiable, claim-stale, state-locked or unseen-notes. Its message, savedNote and recovery
give the manual next step.

Worker lifecycle:
  --await-approval <id>  capture every pending note and keep the claim while awaiting the user. Prints the
                         "covered" notes; "new": true marks the ones to propose now. It is NOT user approval.
  --complete <id>        finish after approved delivery, local-only work, no change or a decline. Refused with
                         unseen-notes (claim kept) while any note was never captured.
  --release <id>         manual recovery only: abandon a claim without marking notes reviewed. First make sure
                         no worker for the request is still running.
  -h, --help             show this help

No automatic retries, relaunches or releases. A failed, uncertain or orphaned request keeps its claim until manually released.`;

function paths(options = {}) {
  const home = options.home ?? homedir();
  const root = options.stateRoot ?? join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "omp", "skill-feedback");
  return { home, root, requests: join(root, "requests"), claims: join(root, "claims"), completed: join(root, "completed") };
}

function privateDirectories(store) {
  for (const directory of [store.root, store.requests, store.claims, store.completed]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function claimTarget(path) {
  try {
    return readlinkSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function checkedRequest(store, id) {
  if (!requestId.test(id)) throw new Error("Invalid feedback request ID.");
  const directory = join(store.requests, id);
  return { directory, request: json(join(directory, "request.json")) };
}

function receipt(directory, request, status = request.status) {
  return {
    status, request: request.id, skill: request.skill, source: request.source,
    role: "default", fromTask: request.fromTask, document: join(directory, "worker.md"), notes: join(directory, "notes"),
    ...(request.session !== undefined ? { session: request.session } : {}),
    ...(request.tab !== undefined ? { tab: request.tab } : {}),
    ...(request.block !== undefined ? { block: request.block } : {}),
    ...(request.window ? { window: request.window } : {}),
    ...(request.message ? { message: request.message } : {}),
  };
}

function releaseRecovery(request) {
  return { claim: request.claim, recovery: `${command} --release ${request.id}` };
}

function alreadyReviewed(store, key) {
  const marker = join(store.completed, key);
  if (!existsSync(marker)) return undefined;
  const previous = checkedRequest(store, json(marker).request);
  return receipt(previous.directory, previous.request, "already-reviewed");
}

// Notes appear atomically and are never replaced: identical feedback keeps its first copy.
function addNote(directory, key, note) {
  const path = join(directory, "notes", `${key}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(note, null, 2)}\n`, { mode: 0o600 });
  try {
    linkSync(temporary, path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temporary);
  }
  return path;
}

function readNotes(directory) {
  return readdirSync(join(directory, "notes")).flatMap(name => {
    const key = noteName.exec(name)?.[1];
    if (!key) return [];
    const path = join(directory, "notes", name);
    return [{ arrived: statSync(path).mtimeMs, note: { key, ...json(path) } }];
  }).sort((a, b) => a.arrived - b.arrived || a.note.key.localeCompare(b.note.key)).map(({ note }) => note);
}

class StateLocked extends Error {
  constructor(lock, holder, state) {
    const what = holder ? `${holder.operation} for request ${holder.request}${holder.process?.pid ? ` (pid ${holder.process.pid})` : ""}` : "an unreadable holder";
    const finish = ["complete", "release"].includes(holder?.operation) ? `, run \`${command} --${holder.operation} ${holder.request}\` to finish the interrupted step` : "";
    const held = state === "gone" ? "whose process is gone: that step was interrupted"
      : `whose process the OS could not verify within ${lockWaitMs / 1000} s: that step may have been interrupted`;
    super(state === "alive"
      ? `Another feedback command for this skill is still running: ${what}. Nothing was changed; rerun this command after it finishes.`
      : `The skill's feedback state lock ${lock} is held by ${what}, ${held}. Nothing was changed. If no submit.mjs command for this skill is still running, remove the lock with the recovery command${finish}, then rerun this command.`);
    this.lock = lock;
    this.holder = holder;
    this.state = state;
  }
}

function lockFields(error) {
  return { lock: error.lock, lockHolder: error.holder, lockHolderState: error.state, message: error.message,
    ...(error.state === "alive" ? {} : { recovery: `rm ${JSON.stringify(error.lock)}` }) };
}

function holder(operation, request, identity) {
  return { operation, request, process: identity, since: new Date().toISOString() };
}

/**
 * Serializes every note append and request change for one skill across processes. A holder that
 * crashes leaves the lock in place: later commands fail visibly with StateLocked, never break it.
 */
async function withLock(claim, owner, body) {
  const lock = `${claim}.lock`;
  const own = `${lock}.${randomUUID()}.tmp`;
  writeFileSync(own, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  try {
    const deadline = Date.now() + lockWaitMs;
    for (;;) {
      try {
        linkSync(own, lock);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      let current;
      try {
        current = JSON.parse(readFileSync(lock, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") continue;
      }
      const state = processState(current?.process);
      if (state === "gone" || Date.now() >= deadline) throw new StateLocked(lock, current ?? null, state);
      await sleep(25);
    }
    try {
      return await body();
    } finally {
      const held = statSync(lock, { throwIfNoEntry: false });
      const mine = statSync(own);
      if (held?.ino === mine.ino && held.dev === mine.dev) unlinkSync(lock);
    }
  } finally {
    unlinkSync(own);
  }
}

// Runs under the lock, so a launcher cannot record its result between the read and this check.
function coalesced(directory, request, savedNote) {
  const where = request.block !== undefined ? ` (tern block ${request.block})` : "";
  let status, message, owner;
  if (["preparing", "launching", "launched", "awaiting-approval"].includes(request.status)) {
    // Until the launcher records its result, it owns the request; a fast worker may already wait.
    const launching = request.launchResult === undefined;
    const identity = launching ? request.submitterProcess : request.workerProcess;
    const state = processState(identity);
    if (state === "alive") {
      return ["preparing", "launching"].includes(request.status)
        ? { ...receipt(directory, request, "recorded"), savedNote,
          message: "Saved to the request whose launcher is still confirming startup; no new worker or prompt was sent." }
        : { ...receipt(directory, request, "already-open"), savedNote,
          message: "Saved to the open worker's request; it must capture and propose this note before it can complete. No new worker or prompt was sent." };
    }
    owner = { role: launching ? "launcher" : "worker", process: identity ?? null, state };
    if (launching) {
      status = state === "gone" ? "launch-interrupted" : "launch-unverifiable";
      message = `${state === "gone" ? "The process that claimed this request exited" : "The OS cannot verify the process that claimed this request"} before recording a launch result, so a worker tab may or may not exist. Check \`tern ls --json\` once: if this request's worker is running, let it finish; otherwise run the recovery command.`;
    } else {
      status = state === "gone" ? "worker-gone" : "worker-unverifiable";
      message = state === "gone"
        ? `The worker${where} exited without completing this request. Run the recovery command.`
        : `The OS cannot verify this request's worker${where}. If tern shows it still running, let it finish; otherwise run the recovery command.`;
    }
  } else if (["saved-not-launched", "launch-uncertain"].includes(request.status)) {
    status = request.status;
    message = request.message ?? "This request's launch failed or is uncertain.";
  } else {
    status = "claim-stale";
    message = `This request is ${request.status} but still holds the skill's claim: an earlier --complete or --release was interrupted. Run the recovery command.`;
  }
  return { ...receipt(directory, request, status), savedNote, ...releaseRecovery(request), ...(owner ? { owner } : {}),
    message: `${message} Your note is saved at ${savedNote}; release leaves notes unreviewed, so resubmit them afterwards if still wanted. Nothing was retried automatically.` };
}

function workerDocument(directory, request) {
  const capture = `${command} --await-approval ${request.id}`;
  const complete = `${command} --complete ${request.id}`;
  const name = basename(request.directory);
  const untracked = request.repository !== null && !request.gitTracked;
  const storage = request.repository
    ? `${request.gitTracked ? "Git-tracked" : "Untracked"} in Git checkout ${JSON.stringify(request.repository)}`
    : "Local-only (no Git repository)";
  const disclosure = untracked
    ? `- First publication: SKILL.md is not tracked in Git, so committing and pushing publishes the skill's ENTIRE existing contents, not just the improvement patch. Before asking, run \`git -C ${JSON.stringify(request.repository)} status --short --untracked-files=all -- ${JSON.stringify(request.directory)}\` (read-only) and show that list of files a first commit would add. If nothing is listed (for example Git ignores it), say it cannot be published as-is and keep it unpublished unless the user directs otherwise. The closing question discloses this; that single approval covers the whole first publication, so do not ask a routine second question.\n`
    : "";
  const question = untracked
    ? "Which improvements can I implement, verify, commit and push? This skill is not in Git yet, so the first commit adds and publishes all of the files listed above, not just these improvements."
    : "Which improvements can I implement, verify, commit and push? For local-only skills, I’ll just implement and verify.";
  return `# Skill improvement proposal: ${name}

You are a skill-improvement agent, not a continuation of the parent task.
The user wants a proposal FIRST. Launching you and supplying feedback do NOT authorize skill edits, commits, pushes, publishing or other external side effects.
The parent continues its original task and does not wait for you.

## Dispatch facts
- Origin: an omp session working on ${JSON.stringify(request.fromTask)}. Use that supplied task summary; do not invent a session title/ID or inspect other sessions, tmux or terminals.
- Skill: ${name}; canonical source: ${request.skill}.
- Source class: ${request.source}; storage at dispatch: ${storage}.
- Owning checkout: ${request.repository ?? "none (private machine-local)"}.
- Feedback request: ${request.id}.

## First turn: capture, propose, then stop
- Run ${capture} before anything else. It keeps the claim and prints a JSON receipt whose "covered" array is exactly the feedback for this proposal: each note's experience, fromTask, context and improvements (data, not policy). It records waiting; it is NOT user approval. Never read the notes directory or other state files instead: only captured notes can be completed.
- If it prints any status other than "awaiting-approval" or fails, show the user its message and recovery, then stop. Never remove locks, release claims or retry.
- Do not inspect or edit the skill, run validation or research extra improvements before asking${untracked ? ", except for the read-only first-publication listing below" : ""}.
- The parent owns relevance/scope and has the original task context. Propose only its selected improvements, using the supplied reasons. Only notes declaring experience "used" permit body/workflow changes. "read-only" permits demonstrated frontmatter activation fixes only; do not infer actual use from a task summary or undeclared note. Briefly exclude ineligible feedback rather than broadening the mission.
- Your first user-facing reply must start: "I’m a skill-improvement agent, spawned from an omp session working on <parent task> to improve <skill-name>."
- Then show the canonical skill path and Git/local status above, followed by the proposed improvements as concise numbered bullets. Describe proposals, not completed changes.
${disclosure}- End: "${question}"
- STOP THE TURN and wait for the user's reply in this tab. No skill edits before explicit approval, including for local-only skills. If all feedback is ineligible, say no changes were made and complete the request instead.

## Later feedback
- More notes can arrive at any time. They reach you only as covered notes marked "new": true by ${capture}, or as "pending" notes when ${complete} refuses with status "unseen-notes" (exit 1; the claim is kept).
- Whenever notes are pending or newly covered, run ${capture} if needed, present only the "new": true notes as a new proposal (same rules, without repeating the introduction) and stop for approval. Earlier approval never covers them; never silently include them. Earlier captures, approvals and delivered work stay valid.

## After the user approves
- One explicit approval covers implementing, verifying, committing and pushing the selected items for Git-backed skills, unless the user limits permission. For gitless skills, implement and verify only; never create a repository. If the user declines all items, complete with no edits. Do not ask them to repeat the supplied context or routinely ask again before commit/push.
- Read skill://create-skill and applicable source instructions, then the current skill and necessary bundled resources. Verify the owning source/worktree before editing; preserve existing changes. Do not switch a shared checkout's branch.
- Edit the owning source directly. Never copy private/team content into a public repo or create a repository to publish local-only skills. Do not manufacture changes if feedback is factually mistaken, already addressed, unsafe or blocked; briefly explain instead. Preserve valid intended uses.
- Stay within approved feedback and necessary skill resources. No independent improvements, unrelated task work, broad cleanup, instructions elsewhere, monitoring calls or external side effects beyond the authorized commit/push.
- Follow create-skill validation and exercise affected behavior where possible. For trigger wording, review intended/excluded examples without service calls or extra model evaluation; report an applicability review, not a measured routing guarantee. Do not add wording/source-text tests.
- Do not create feedback workers or subagents. OMP_SKILL_FEEDBACK_WORKER marks this session; retain normal rules and safety extensions.

## Results and publication
- Report the skill and parent task, then concise bullets of the approved improvements actually made; briefly identify anything not implemented and why. End with verification and the pushed commit/destination, or local-only / unpublished status. No process narrative.
- Before publication, re-read the actual diff. Changed scope (including files to publish that differ from a disclosed first-publication list), failed verification, an unclear destination, force-push requirements or inability to isolate approved changes/commits must STOP publication. Retain the claim with ${capture}, explain the issue and wait; never treat initial approval as permission to bypass these limits.
- Commit/push only approved changes using the owning repo's conventions. Never include unrelated edits or unapproved commits, force-push or silently switch a shared branch; isolate publication in another worktree if needed.
- After approved delivery (including Git commit/push by default), approved local-only or explicitly unpublished edits, no change being warranted, or the user declining, run ${complete}. It succeeds only once every note is captured: on "unseen-notes" the request is not finished, so follow "Later feedback". Gitless skills have no push destination: say local-only. Never release a request merely because a turn ends while approval or a publication blocker is pending.
- If any state command prints another non-success status (such as "state-locked") or fails, report its message and recovery to the user and stop; do not remove locks or release the claim yourself.
`;
}

export async function submitFeedback(input, options = {}) {
  const env = options.env ?? process.env;
  if (env.OMP_SKILL_FEEDBACK_WORKER) throw new Error("Skill-improvement workers cannot submit feedback or launch another worker.");
  if (!/^\d+$/.test(env.TERN_PANE ?? "")) throw new Error("Skill feedback is only for omp running inside a Tern pane.");
  if (!["used", "read-only"].includes(input.experience)) {
    throw new Error("--experience must be used (actually applied the skill) or read-only (frontmatter activation feedback only).");
  }
  if (typeof input.fromTask !== "string" || !input.fromTask.trim() || /[\r\n]/.test(input.fromTask)) {
    throw new Error("--from-task must be a short, nonempty, single-line summary of the parent's work.");
  }
  const fromTask = input.fromTask.trim();
  const improvements = [...new Set((input.improvements ?? []).map(value => {
    if (typeof value !== "string" || !value.trim()) throw new Error("Each improvement must be nonempty text.");
    return value.trim();
  }))];
  if (!improvements.length) throw new Error("Supply at least one --improvement; several ideas may be submitted together.");
  if (input.context !== undefined && typeof input.context !== "string") throw new Error("Context must be text.");
  const store = paths(options);
  const owner = resolveSkill(input.skill, { home: store.home });
  const note = { revision: owner.revision, experience: input.experience, fromTask, context: input.context?.trim() ?? "", improvements };
  // Attribution must not turn identical feedback from another parent into a new review.
  const noteKey = hash(JSON.stringify({ skill: owner.skill, revision: note.revision, experience: note.experience, context: note.context, improvements: [...improvements].sort() }));
  privateDirectories(store);
  const reviewed = alreadyReviewed(store, noteKey);
  if (reviewed) return reviewed;

  const id = randomUUID();
  const directory = join(store.requests, id);
  const file = join(directory, "request.json");
  const claim = join(store.claims, hash(owner.skill));
  mkdirSync(join(directory, "notes"), { recursive: true, mode: 0o700 });
  // Other submitters judge whether this launch is still in progress by this identity.
  const submitterProcess = identifyProcess();
  const request = { id, ...owner, fromTask, status: "preparing", created: new Date().toISOString(), claim, submitterProcess };
  writeJson(file, request);
  const savedNote = addNote(directory, noteKey, note);
  writeFileSync(join(directory, "worker.md"), workerDocument(directory, request), { mode: 0o600 });
  writeFileSync(join(directory, "fresh.yml"), "autoResume: false\n", { mode: 0o600 });
  const own = (status, message, extra = {}) => {
    Object.assign(request, { status, message });
    writeJson(file, request);
    return { ...receipt(directory, request), savedNote, ...extra, message };
  };
  if (!submitterProcess) {
    return own("saved-not-launched", `The OS could not verify this process, so no claim was taken and no worker was started. Your note is saved at ${savedNote}; resubmit it later.`);
  }

  let existing;
  try {
    existing = await withLock(claim, holder("submit", id, submitterProcess), () => {
      const reviewedNow = alreadyReviewed(store, noteKey);
      if (reviewedNow) return { reviewed: reviewedNow };
      const target = claimTarget(claim);
      if (target === undefined) {
        symlinkSync(directory, claim);
        request.status = "launching";
        writeJson(file, request);
        return undefined;
      }
      if (dirname(target) !== store.requests || !requestId.test(basename(target))) {
        throw new Error(`Invalid claim target; inspect ${claim} manually.`);
      }
      const saved = addNote(target, noteKey, note);
      return { result: coalesced(target, json(join(target, "request.json")), saved) };
    });
  } catch (error) {
    if (error instanceof StateLocked) {
      const fields = lockFields(error);
      return own("state-locked", `${fields.message} Your note is saved at ${savedNote}; no claim was taken and no worker was started.`, fields);
    }
    // The claim may already be ours if a later step failed; then only a manual release frees it.
    let claimed = false;
    try {
      claimed = claimTarget(claim) === directory;
    } catch {}
    return own("saved-not-launched", `${error.message} Your note is saved at ${savedNote}; no worker was started.`,
      claimed ? releaseRecovery(request) : {});
  }
  if (existing) {
    rmSync(directory, { recursive: true });
    return existing.reviewed ?? existing.result;
  }

  let launched;
  try {
    launched = await (options.launch ?? launchWorker)({ cwd: owner.cwd, document: join(directory, "worker.md"),
      config: join(directory, "fresh.yml"), workerId: id, env });
  } catch (error) {
    launched = { status: "saved-not-launched", message: error.message };
  }
  let latest;
  try {
    latest = await withLock(claim, holder("record-launch", id, submitterProcess), () => {
      const current = json(file);
      // A very fast worker can capture notes, await approval or finish before startup confirmation returns.
      Object.assign(current, launched, { launchResult: launched.status },
        ["awaiting-approval", "complete", "released"].includes(current.status) ? { status: current.status } : {});
      writeJson(file, current);
      return current;
    });
  } catch (error) {
    if (!(error instanceof StateLocked)) throw error;
    const fields = lockFields(error);
    return { ...receipt(directory, { ...request, ...launched }, "state-locked"), savedNote, ...fields, launchStatus: launched.status,
      message: `${fields.message} The launch result (${launched.status}${launched.message ? `: ${launched.message}` : ""}) could not be recorded.` };
  }
  return { ...receipt(directory, latest, launched.status), savedNote, ...(successes.has(launched.status) ? {} : releaseRecovery(latest)) };
}

export async function setRequestState(id, status, options = {}) {
  if (!Object.hasOwn(operations, status)) throw new Error("Invalid request state.");
  const marker = (options.env ?? process.env).OMP_SKILL_FEEDBACK_WORKER;
  if (marker && marker !== id) throw new Error("A worker may only update its own request.");
  const store = paths(options);
  const { directory, request: initial } = checkedRequest(store, id);
  const file = join(directory, "request.json");
  try {
    return await withLock(initial.claim, holder(operations[status], id, identifyProcess()), () => {
      const request = json(file);
      if (claimTarget(request.claim) !== directory) {
        if (status !== "awaiting-approval" && request.status === status) return receipt(directory, request);
        throw new Error("This request no longer owns the skill's claim.");
      }
      const notes = readNotes(directory);
      const covered = new Set(request.covered ?? []);
      const unseen = notes.filter(note => !covered.has(note.key));
      request.updated = new Date().toISOString();
      if (status === "awaiting-approval") {
        request.status = status;
        request.covered = [...covered, ...unseen.map(note => note.key)];
        writeJson(file, request);
        const fresh = new Set(unseen.map(note => note.key));
        return { ...receipt(directory, request), covered: notes.map(note => ({ ...note, new: fresh.has(note.key) })) };
      }
      if (status === "complete") {
        if (unseen.length) {
          return { ...receipt(directory, request, "unseen-notes"), pending: unseen,
            message: `${unseen.length} note(s) arrived after your last capture and were never proposed, so the request stays open and nothing was marked reviewed. Run \`${command} --await-approval ${id}\`, propose the notes marked "new" and wait for approval before completing.` };
        }
        for (const key of covered) writeJson(join(store.completed, key), { request: id });
      }
      // Recorded before the claim is dropped: a crash in between leaves a visible claim-stale request.
      request.status = status;
      writeJson(file, request);
      unlinkSync(request.claim);
      return status === "released"
        ? { ...receipt(directory, request), message: `Released without marking notes reviewed; they remain in ${join(directory, "notes")}. Resubmit any that are still wanted.` }
        : receipt(directory, request);
    });
  } catch (error) {
    if (!(error instanceof StateLocked)) throw error;
    return { ...receipt(directory, json(file), "state-locked"), ...lockFields(error) };
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    skill: { type: "string" }, experience: { type: "string" }, "from-task": { type: "string" }, improvement: { type: "string", multiple: true }, context: { type: "string" },
    "await-approval": { type: "string" }, complete: { type: "string" }, release: { type: "string" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log(usage);
    return;
  }
  const actions = [values["await-approval"], values.complete, values.release].filter(value => value !== undefined);
  if (actions.length > 1 || (actions.length && (values.skill || values.experience !== undefined || values["from-task"] !== undefined || values.improvement || values.context !== undefined))) {
    throw new Error("Use either a submission or exactly one request-state action.");
  }
  if (!actions.length && (!values.skill || !isAbsolute(values.skill))) throw new Error("--skill must be an absolute skill path; see --help.");
  const result = actions.length
    ? await setRequestState(actions[0], values["await-approval"] ? "awaiting-approval" : values.complete ? "complete" : "released")
    : await submitFeedback({ skill: values.skill, experience: values.experience, fromTask: values["from-task"], improvements: values.improvement, context: values.context });
  console.log(JSON.stringify(result));
  if (!successes.has(result.status)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
