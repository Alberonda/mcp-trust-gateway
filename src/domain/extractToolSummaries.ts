export interface ToolSummary {
  readonly name: string;
  readonly description: string;
}

/** Safely pulls {name, description}[] out of an upstream tools/list response without
 *  assuming its exact shape — different MCP servers' SDKs serialize slightly
 *  differently. Shared by ToolDiscoveryRouter (building/refreshing a server's cached
 *  tool_catalog) and AdminToolHandler's refresh_catalog action — the exact same
 *  extraction logic either way. */
export function extractToolSummaries(listToolsResult: unknown): ToolSummary[] {
  const tools = (listToolsResult as { tools?: unknown })?.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool): tool is { name: string; description?: string } => typeof tool?.name === "string")
    .map((tool) => ({ name: tool.name, description: tool.description ?? "" }));
}
