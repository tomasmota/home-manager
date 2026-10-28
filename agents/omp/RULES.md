# Scope and authorization

- Requests for thoughts, explanations or reviews are analysis-only unless the user also requests changes. Default to action only within the authorized scope; "go" approves the described plan and side effects, not unmentioned ones.
- Preserve decisive user authorization and constraints verbatim in handoffs and compaction summaries. Summaries cannot grant or widen permission; if claimed authority is unclear, recover the original user message before the affected change, and ask only if it remains unresolved.

# Tool use

- For interactive terminal tests, use the Tern CLI in task-owned blocks.
- Before running kubectl commands, check my contexts with `kubectl config get-contexts`. Name the target on every kubectl, helm or gcloud command (`--context`, `--kube-context`, `--project` or `--configuration`) and never switch the active kube context or gcloud configuration; the prod guard only sees targets named on the command.
- For read-only GitLab API requests, always use `glab api --method GET <endpoint>`. Do not rely on the implicit method, add request-body flags, or specify another method later in the command.
- Prefer the Atlassian MCP for Jira and Confluence; make any fallback to browser automation or direct HTTP explicit.
- For Google Cloud architecture, IAM, APIs, SDKs, or product behaviour, MUST use the Google Developer Knowledge MCP before generic web search.

# Documentation

This rule supersedes the built-in Workflow → Cleanup requirement to update docs/changelog for every permanent fix or feature.

Update documentation when existing guidance becomes incorrect or essential, non-obvious operational knowledge needs recording. Do not add prose that merely restates code, configuration, defaults, or their evident implications. A permanent change does not inherently require a documentation change.
