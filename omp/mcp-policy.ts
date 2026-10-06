// Workstation MCP boundary. Unknown Confluence tools stay denied even when
// the server adds tools; approval settings alone only support exact names.
// Blocked tools are also removed from the active set, so their schemas and
// xd:// routes never reach the model context (omp has no per-server tool
// filter). The tool_call gate stays the enforcement point.
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

type Api = {
  on(event: "tool_call", handler: (event: { toolName: string }) =>
    { block: true; reason: string } | undefined): void;
  on(event: "before_agent_start" | "turn_end", handler: () => Promise<void>): void;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): Promise<void>;
};

export default function mcpPolicy(pi: Api) {
  pi.on("tool_call", event => {
    const reason = blockedReason(event.toolName);
    return reason ? { block: true, reason } : undefined;
  });

  // Every MCP refresh (deferred startup discovery, reconnect, list_changed)
  // re-activates all server tools, and omp re-reads the active set before
  // each model call. Re-trim at prompt and turn boundaries; setActiveTools
  // rebuilds the system prompt, so call it only when something changes.
  const hideBlocked = async () => {
    const active = pi.getActiveTools();
    const allowed = active.filter(name => !blockedReason(name));
    if (allowed.length !== active.length) await pi.setActiveTools(allowed);
  };
  pi.on("before_agent_start", hideBlocked);
  pi.on("turn_end", hideBlocked);
}
