const COMPACTION_GUIDANCE = `## Additional compaction requirements

Treat the summary as a factual handoff to an agent that has not seen the earlier conversation.

- Preserve information in this priority order: origin and objective evolution; explicit constraints and preferences; decisions, alternatives, and their rationale; exact evidence and identifiers; then work state and next actions. Omit acknowledgements and generic workflow prose first.
- In Objective, state the original user request or initiating problem before the latest goal explicitly visible in the supplied history.
- Start Important Details with a labeled "Origin and evolution" bullet. Give a concise chronological trail from the original request through material reframes and decisions to the latest state visible in the supplied history.
- For every proposed, accepted, rejected, deferred, or superseded approach, preserve its status and the exact stated rationale. Never replace a rationale with vague wording such as "not accepted"; if no reason was recorded, say so.
- Reconcile contradictions before writing. The newest confirmed information in the supplied history wins; label important replaced information as superseded only when evidence shows it was previously authoritative, otherwise identify it as a contradicted or unverified claim.
- Distinguish user-provided facts, reported actions, observed results, and investigation-derived conclusions. Mark material uncertainty as unverified instead of guessing.
- Preserve exact file paths, symbols, commands, errors, identifiers, numeric thresholds, and verification results when they affect continuation.
- Preserve the scope and precedence of technical conditions. Do not describe a default, fallback, bound, or branch as applying to an explicit override or another branch unless the evidence says it does.
- When the history marks a command, log, error, event, query, or other string as exact or verbatim, copy the entire contiguous string into one code span without shortening, splitting, normalizing punctuation, or paraphrasing it. Put provenance or interpretation outside that code span.
- Do not turn a proposal or design decision into implemented or completed work. Do not claim a reported command was run in this session.
- In Active, Blocked, and Next Move, include only states and actions explicitly supported by the supplied history. A prerequisite, future possibility, or condition such as "until X" is not an assigned next action. Next Move may contain only explicit user-assigned or already-established actions; fill unused entries with "(none)" instead of inventing recommendations.
- Treat a previous summary as a useful anchor, not as authority. Restore still-valid details present in the conversation history when an earlier summary omitted them, while preserving the original request across repeated compactions.
- Keep the result concise and follow the required output structure exactly.`

export const CompactionContextPlugin = async () => ({
  "experimental.session.compacting": async (_input, output) => {
    output.context.push(COMPACTION_GUIDANCE)
  },
})
