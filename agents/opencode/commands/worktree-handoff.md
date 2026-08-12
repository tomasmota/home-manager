---
description: Write a concise, factual handoff for another agent continuing this linked worktree.
agent: build
---

Prepare the persistent worktree handoff now. Do not continue the task after writing it.

Read the repository-root `.opencode-worktree-context.md`, the current conversation, `git status --short`, and relevant diffs. The document is local worktree metadata and must remain uncommitted.

Keep `## Original Request` verbatim. Do not repeat it in the handoff. If `## Task Definition` is still the placeholder, replace it with a concise objective, constraints, and acceptance criteria. Otherwise, change it only if the user explicitly changed scope.

Replace the complete `## Current Handoff` section with this concise, factual snapshot:

```markdown
## Current Handoff

Updated: <local ISO 8601 timestamp>

### Status
<what is actually complete and what remains>

### Changes
<relevant modified files and behavioral effect>

### Decisions And Rationale
<accepted, rejected, deferred, or superseded decisions and their stated rationale>

### Verification
<commands run and their results, or "Not run">

### Blockers And Unknowns
<known blockers, uncertainty, or "None">

### Next Steps
<only explicit or already-established next actions, or "None">
```

Reconcile contradictions before writing. Preserve exact paths, symbols, commands, errors, identifiers, and relevant numeric thresholds. Distinguish user-provided facts, observed results, and unverified claims. Do not claim work or verification that did not occur. Keep the handoff under 800 words.

When finished, report that the handoff is ready and state its timestamp.
