# Skill improvements

- In omp inside Tern, before final, silently consider useful improvements
  grounded in applying skills. Reading alone permits only demonstrated
  frontmatter activation feedback. No audits or invented work; none means no action.
- Parent owns relevance/scope; pass concise reasons/context, no secrets.
  Only main agents submit; subagents report to parent. Workers
  (`OMP_SKILL_FEEDBACK_WORKER`) never submit.
- For selected feedback, run `node ~/.config/home-manager/agents/omp/skill-feedback/submit.mjs --help`,
  then batch one submission per skill; use bash timeout **120 seconds**. Report failures in one line.
- Continue your task; do not edit the skill, wait/poll, retry launches or
  troubleshoot Tern. The default-role worker in `skill-improvements` must ask
  for approval covering edits, verification and Git commit/push; local-only stays local.
