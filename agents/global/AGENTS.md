<!-- Generated from agents 57c6edfc6ce2dece2ff5fd07ec1a8604960a6a92; edit the platform adapter or shared source. -->

# This machine
- My terminal is ghostty
- Almost everything is configured using home-manager. All config is located at `~/.config/home-manager/`. If I ask you to change some configuration in home-manager, this is where you will find it. Read `~/.config/home-manager/AGENTS.md` for more information.

# Tips for you
- if you want to run kubectl commands, first check my contexts with `kubectl config get-contexts`
- if you want to run commands in a context, use `kubectl --context`, not `kubectl config use-context`
- For read-only GitLab API requests, always use `glab api --method GET <endpoint>`. Do not rely on the implicit method, add request-body flags, or specify another method later in the command.
- Gcloud re-auth is handled by the `tomas.gcloud-auth-healer` plugin: when a gcloud/ADC command fails with an expired-session error it starts the re-login in the background and posts a synthetic message. Follow that message (complete the browser prompt, poll the failing command, give up after ~5 min).
- In a confirmed tmux TUI, opening a file uses a pane to the right: `tmux split-window -h -c <dir> -t "$TMUX_PANE" 'nvim <file>'`. The shared base owns client detection; this command is not an OpenChamber action.

# skills
- If I ask for a skill that should stay only on this machine or should not live in the public home-manager repo, create it under `~/.agents/local-skills/`.
- Workstation-specific tracked skill sources live under `agents/skills/`, alongside generated portable skills. Consult `agents/config/README.md` and its inventories to distinguish ownership before editing.
- `~/.agents/team-skills/` links to my work team's skills repo checkout. Edit team skills there and deliver them through that repo; never copy them into `local-skills`.

# Shared agent base

## Workflow and context

- Find and follow the target repository's `AGENTS.md` and configuration READMEs.
  Inspect the actual worktree, Git status and existing changes before editing;
  preserve unrelated work. Use the project's declared tools and verification,
  commit and deployment workflows rather than assuming one platform's commands.
- Load matching available skills before task-specific work. Read only the
  references needed for the current decision. Treat documentation as a dated
  snapshot and verify mutable environment facts through approved access paths.
- Investigate hypothesis-first: identify the uncertainty blocking action, search
  before broad reading, and gather discriminating evidence. Reproduce bugs when
  feasible before fixing them; after a failure revise the hypothesis, not just
  the command. Retain conclusions rather than raw exploration.
- Treat tool output as context-expensive. Start documentation, API, cloud and log
  queries with targeted fields, filters and bounded results. Broaden only when
  needed, stating which uncertainty the extra output will resolve. For substantial
  browsing of a public repository, prefer a shallow clone in approved scratch
  storage over many individual web fetches.
- Stop investigating when evidence supports a low-regret decision. After two
  failed approaches or three unproductive tool rounds, reassess; if no useful next
  test remains, report the blocker rather than continuing blindly. Distinguish
  required verification from optional expansion of the user's task.
- Perform requested work directly and verify it end to end. Scale checks to risk
  and blast radius, starting with cheap high-signal checks. Consult primary docs
  when behavior is uncertain. Serialize dependent edits and tests.

## Delegation and review

- Use subagents proactively for substantial work; these instructions authorize
  delegation without a separate user request, within the task's scope and the
  applicable platform/project permissions. Keep trivial work inline; do not spawn
  agents merely to meet a quota.
- Delegate context-heavy, read-only discovery to `explore` with a bounded question,
  expected evidence and stopping condition. Keep intermediate searches, reads and
  fetches out of the parent's context; request compressed conclusions with exact
  references and unresolved uncertainties. Read-only explore has no shell or
  mutation tools.
- Delegate independent investigations and implementation chunks to the configured
  role whose advertised description fits; use `general` when no specialist fits.
  Give each agent objectives, relevant context, constraints and file ownership.
- Parallelize only independent work, normally two to four distinct investigations.
  Keep parallel agents read-only by default; use isolated worktrees or nonoverlapping
  file ownership for parallel writes. Do not duplicate delegated effort.
- Trust compressed handoffs and read only the cited ranges needed; redo discovery
  only if the handoff is insufficient or state changed. The parent reconciles
  conflicts and owns integration, correctness, verification and user communication.
- Obtain fresh-context, adversarial review for nontrivial changes when risk
  warrants it, using `reviewer` or another suitable configured role. Subagents never
  create continuation sessions; report budget pressure to the parent. Continuation
  triggers and client-specific execution remain platform policy.

## Tools, models and clients

- Tool availability and names are model-specific. Use each tool's exact advertised
  name and schema. Claude may expose `write`/`edit` or full `mcp__...` gateway aliases;
  GPT may expose `patch`. Never shorten aliases or invent tool names; when plain
  names are advertised, use them. Identify the delegation tool from its advertised
  description, not a guessed alias. In Code Mode, use only exact catalog paths
  returned by `search`, including bracket notation; gateway aliases do not rename
  that catalog.
- Before selecting or configuring a model, consult the available model catalog
  and preserve the exact provider/model ID and supported variant. Do not normalize
  colon suffixes into variants or infer identifiers from a family nickname.
- File opening is client-aware: use OpenChamber file-open/preview in the app. Only
  open a tmux pane when the **current client** is confirmed to be a tmux TUI;
  a shared server's inherited `TMUX`/`TMUX_PANE` is not that proof. If no display
  tool is available, report the path. If presentation fails after a successor
  starts, report its ID; never spawn a duplicate.
- Never print, copy or commit credentials, pairing material, private keys or raw
  authentication/environment/audit transcripts. Public configuration sources must
  not contain work-team contents or confidential infrastructure details.

## Instruction and skill ownership

- Classify new guidance by scope and publication safety before editing. Portable,
  public-safe base behavior belongs in the central `agents` source's
  `config/instructions.md`; machine/client policy belongs in the consumer's
  platform adapter; repository-specific conventions belong in that repo's
  `AGENTS.md`. Keep one canonical rule rather than copying it into both adapters.
- Keep always-loaded instructions short: durable rules and necessary skill
  triggers, not task procedures. Put reusable task-specific steps in a skill and
  use its description for discovery. Add an explicit instruction trigger only
  when ordinary discovery is insufficient or loading the skill is safety-critical.
- Portable public skills belong in central `skills/<name>/SKILL.md`, registered
  with provenance/license metadata and intended profiles in `config/manifest.json`.
  Platform-specific public skills belong in the consumer's owned, non-generated
  skill sources. Project-only skills stay with that project; private/local/team
  skills stay in their existing private owner-managed locations. Read the relevant
  consumer README for exact paths; never publish or copy team contents for parity.
- Skill source ownership and installation are separate decisions: a portable
  skill need not be installed on every platform. Put a shared skill trigger in the
  base only if every affected profile supports it, or explicitly guard it by
  availability. Platform-only skill triggers belong in platform instructions.
  Never imply that a skill grants tools, credentials or remote authority.
- Split mixed guidance into a portable core and a small local adapter/reference;
  keep paths, privileges, providers, browser authority, lifecycle and continuation
  policy local. If scope or publication intent is unclear, ask before publishing
  or broadening installation; do not default private material into a public repo.
- For shared changes: read central and consumer configuration READMEs, edit the
  canonical source, test/review, commit/push it, then deliberately advance each
  intended consumer's immutable lock and render/check. Deploy and verify each
  reachable target through its own runbook; record blocked target acceptance
  honestly. Generated global instructions and portable skills are outputs, never
  editable sources. For local changes, update only the owning adapter/source and
  follow that consumer's render/deploy/verify workflow.
