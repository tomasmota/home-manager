---
mode: subagent
description: General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.
model: zai-coding-plan/glm-5.3-flash
permissions:
  # Allow spawning exactly one level: explore is read-only and cannot spawn
  # further subagents, so recursion is capped at depth 1 by construction.
  # Never add "general" as an allowed resource here; that would recurse.
  - action: subagent
    resource: "*"
    effect: deny
  - action: subagent
    resource: explore
    effect: allow
---
