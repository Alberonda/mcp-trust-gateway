/**
 * The only slice of the MCP SDK's Client that ToolCallHandler actually needs (Interface
 * Segregation) — depending on this instead of the full SDK Client keeps the handler
 * decoupled from the SDK's much larger surface, and lets tests use a trivial fake instead
 * of a real MCP connection.
 */
export interface UpstreamToolClient {
  listTools(): Promise<unknown>;
  callTool(name: string, args: unknown): Promise<ToolCallResult>;
}

export interface ToolCallResult {
  readonly isError?: boolean;
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}
