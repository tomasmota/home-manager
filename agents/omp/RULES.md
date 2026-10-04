# Always-apply rules

These rules are sticky: they stay in context for the whole session, across
compaction. They are the omp port of the concise always-on part of the shared
agent base; the full base still loads from `~/.agents/AGENTS.md`.

- Read the target repository's `AGENTS.md`, READMEs and declared workflows
  before editing; preserve unrelated work and follow the project's own tools,
  verification, commit and deployment workflows.
- Investigate hypothesis-first: identify the uncertainty blocking action,
  search before broad reading, gather discriminating evidence, and revise the
  hypothesis (not just the command) after failures.
- Treat tool output as context-expensive. Start documentation, API, cloud and
  log queries with targeted fields, filters and bounded results; broaden only
  when a stated uncertainty needs it.
- Stop investigating when evidence supports a low-regret decision. After two
  failed approaches or three unproductive tool rounds, reassess or report the
  blocker instead of continuing blindly.
- Parallelize only independent work; serialize dependent edits and tests. Do
  not duplicate delegated effort; trust compressed handoffs and read only the
  cited ranges you need.
- Scale checks to risk and blast radius, starting with cheap high-signal
  checks; consult primary docs when behavior is uncertain.
- Never print, copy or commit credentials, pairing material, private keys or
  raw authentication/environment/audit transcripts.
- Public configuration sources must not contain work-team contents or
  confidential infrastructure details.
- Distinguish required verification from optional expansion of the user's
  task; report unverified work honestly instead of claiming it done.
- Before delegated MCP use, verify the workstation MCP policy extension is
  loaded. Do not delegate MCP calls after extension errors or when extensions
  are disabled: headless task children do not inherit the parent's prompt mode.
