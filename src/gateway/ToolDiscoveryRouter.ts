import { AuditStatus } from "../constants.js";
import type { AuditLogRepository } from "../db/AuditLogRepository.js";
import type { Identity } from "../db/types.js";
import { redact } from "../redact.js";
import type { ToolCallHandler } from "./ToolCallHandler.js";
import type { ToolCallResult } from "./UpstreamToolClient.js";

/**
 * The Phase 2 differentiator (see DESIGN.md's "Competitive landscape & differentiation"):
 * instead of an agent's context paying for every real tool's full JSON schema across every
 * connected server, the gateway exposes exactly two meta-tools — find_tool and call_tool —
 * regardless of how many real servers/tools sit behind it. Composes one ToolCallHandler per
 * accessible server without modifying ToolCallHandler itself (Open/Closed).
 */

export interface DiscoveredTool {
  readonly server: string;
  readonly name: string;
  readonly description: string;
}

/** The two meta-tools' own schemas — this is the entire tools/list payload an agent pays
 *  context for, no matter how many real servers/tools are registered behind the gateway. */
export const META_TOOLS = [
  {
    name: "find_tool",
    description:
      "Search for available tools across every server you have access to. Call this first " +
      "to discover what you can do, then call call_tool with the exact server/tool it returns.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Keyword(s) to search for, or empty to list everything" } },
    },
  },
  {
    name: "call_tool",
    description: "Call a real tool discovered via find_tool.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "The \"server\" value returned by find_tool" },
        tool: { type: "string", description: "The \"name\" value returned by find_tool" },
        arguments: { type: "object", description: "Arguments for the underlying tool" },
      },
      required: ["server", "tool"],
    },
  },
] as const;

/** Safely pulls {name, description}[] out of an upstream tools/list response without
 *  assuming its exact shape — different MCP servers' SDKs serialize slightly differently. */
function extractToolSummaries(listToolsResult: unknown): Array<{ name: string; description: string }> {
  const tools = (listToolsResult as { tools?: unknown })?.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool): tool is { name: string; description?: string } => typeof tool?.name === "string")
    .map((tool) => ({ name: tool.name, description: tool.description ?? "" }));
}

export class ToolDiscoveryRouter {
  constructor(
    private readonly handlers: readonly ToolCallHandler[],
    /** Only needed to audit calls to a server this identity was never even connected to
     *  (see callTool below) — every other audit entry is written by the per-server
     *  ToolCallHandler that already owns identity/audit wiring for its own server. */
    private readonly identity: Identity,
    private readonly auditLog: AuditLogRepository,
  ) {}

  listMetaTools(): { tools: typeof META_TOOLS } {
    return { tools: META_TOOLS };
  }

  /** Searches every accessible server's real tool list by name/description substring match
   *  (case-insensitive; empty query matches everything), then drops anything this identity
   *  couldn't actually call — discovery is exactly as strict as calling, never a way to
   *  enumerate tools you have no access to (see ToolCallHandler.isToolAllowed). */
  async findTool(query: string): Promise<DiscoveredTool[]> {
    const term = query.trim().toLowerCase();
    const matches: DiscoveredTool[] = [];

    for (const handler of this.handlers) {
      const candidates = extractToolSummaries(await handler.listTools());
      for (const tool of candidates) {
        const isMatch = !term || tool.name.toLowerCase().includes(term) || tool.description.toLowerCase().includes(term);
        if (!isMatch) continue;
        if (!(await handler.isToolAllowed(tool.name))) continue;
        matches.push({ server: handler.serverName, name: tool.name, description: tool.description });
      }
    }
    return matches;
  }

  /** Routes to the ToolCallHandler for `server` — permission check, forwarding, and
   *  auditing all happen inside that handler exactly as they already did pre-Phase-2. If
   *  `server` isn't one this identity is even connected to, that's still a real access
   *  attempt worth a "complete audit trail of every decision" claim actually meaning
   *  something — logged here directly, since there's no per-server ToolCallHandler to do
   *  it (the gateway process never connected to a server this identity has zero grants on
   *  in the first place). */
  async callTool(server: string, tool: string, args: unknown): Promise<ToolCallResult> {
    const handler = this.handlers.find((h) => h.serverName === server);
    if (!handler) {
      await this.auditLog.write({
        identityId: this.identity.id,
        serverName: server,
        toolName: tool,
        paramsRedacted: redact(args ?? {}),
        status: AuditStatus.Denied,
        resultSummary: `Denied: identity "${this.identity.name}" has no access to server "${server}" (unknown or unpermitted).`,
        durationMs: 0,
      });
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown server "${server}". Call find_tool first to see what's available.` }],
      };
    }
    return handler.callTool(tool, args);
  }

  /** The one entry point the composition root needs for tools/call — dispatches to
   *  find_tool or call_tool by name and formats the response as an MCP tool result. Kept
   *  here rather than in index.ts because "how does a meta-tool call turn into a response"
   *  is this router's concern, not composition-root wiring. */
  async handleMetaToolCall(name: string, args: unknown): Promise<ToolCallResult> {
    const params = (args ?? {}) as Record<string, unknown>;

    if (name === "find_tool") {
      const query = typeof params.query === "string" ? params.query : "";
      const results = await this.findTool(query);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }

    if (name === "call_tool") {
      const server = typeof params.server === "string" ? params.server : undefined;
      const tool = typeof params.tool === "string" ? params.tool : undefined;
      if (!server || !tool) {
        return {
          isError: true,
          content: [{ type: "text", text: 'call_tool requires both a "server" and a "tool" argument — see find_tool\'s output.' }],
        };
      }
      return this.callTool(server, tool, params.arguments);
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool "${name}". Only find_tool and call_tool are exposed — call find_tool first.` }],
    };
  }
}
