// Workstation MCP boundary. Unknown Confluence tools stay denied even when
// the server adds tools; approval settings alone only support exact names.
const confluenceAllowed = new Set([
  "getAccessibleAtlassianResources",
  "getConfluencePage",
  "getJiraIssue",
  "searchConfluenceUsingCql",
  "searchJiraIssuesUsingJql",
  "editJiraIssue",
  "transitionJiraIssue",
  "getTransitionsForJiraIssue",
  "updateConfluencePage",
].map(name => `mcp__confluence_${name.toLowerCase()}`));

export function blockedReason(toolName: string): string | undefined {
  if (toolName.startsWith("mcp__confluence_") && !confluenceAllowed.has(toolName)) {
    return "Tool is not in the workstation Confluence allow-list";
  }
  if (toolName.startsWith("mcp__chrome_devtools_") && (
    toolName.startsWith("mcp__chrome_devtools_performance_") ||
    toolName === "mcp__chrome_devtools_lighthouse_audit" ||
    toolName === "mcp__chrome_devtools_take_heapsnapshot"
  )) {
    return "Chrome profiling tools are disabled on this workstation";
  }
  return undefined;
}

export default function mcpPolicy(pi: {
  on: (event: "tool_call", handler: (event: { toolName: string }) =>
    { block: true; reason: string } | undefined) => void;
}) {
  pi.on("tool_call", event => {
    const reason = blockedReason(event.toolName);
    return reason ? { block: true, reason } : undefined;
  });
}
