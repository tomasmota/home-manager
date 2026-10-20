# Tool use

- For interactive terminal tests, use the Tern CLI in task-owned blocks.
- Before running kubectl commands, check my contexts with `kubectl config get-contexts`; pass `--context` per command, never `kubectl config use-context`.
- For read-only GitLab API requests, always use `glab api --method GET <endpoint>`. Do not rely on the implicit method, add request-body flags, or specify another method later in the command.
- Prefer the Atlassian MCP for Jira and Confluence; make any fallback to browser automation or direct HTTP explicit.
- For Google Cloud architecture, IAM, APIs, SDKs, or product behaviour, MUST use the Google Developer Knowledge MCP before generic web search.
