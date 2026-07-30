import { AuditStatus, MAX_FIND_TOOL_RESULTS, TOOL_CATALOG_TTL_MS } from "./constants.js";
import type { AllowedTools } from "../ports/PermissionRepository.js";
import type { AuditLogRepository } from "../ports/AuditLogRepository.js";
import type { Embedder } from "../ports/Embedder.js";
import type { NewToolCatalogEntry, ToolCatalogEntry, ToolCatalogRepository } from "../ports/ToolCatalogRepository.js";
import type { Identity } from "./types.js";
import { cosineSimilarity } from "./cosineSimilarity.js";
import { extractToolSummaries } from "./extractToolSummaries.js";
import { redact } from "./redact.js";
import type { AdminToolHandler } from "./AdminToolHandler.js";
import type { SelfServiceHandler } from "./SelfServiceHandler.js";
import type { ToolCallHandler } from "./ToolCallHandler.js";
import type { ToolCallResult } from "../ports/UpstreamToolClient.js";

/**
 * The Phase 2 differentiator (see DESIGN.md's "Competitive landscape & differentiation"):
 * instead of an agent's context paying for every real tool's full JSON schema across every
 * connected server, the gateway exposes a small, fixed set of meta-tools regardless of how
 * many real servers/tools sit behind it. find_tool/call_tool are always present;
 * list_services/register_my_credential are always present (self-service, but never
 * self-granted permission — see SelfServiceHandler); manage_roles is present only when
 * `adminHandler` is supplied, which the composition root only does for identities whose
 * user holds an admin role. Composes one ToolCallHandler per accessible server without
 * modifying ToolCallHandler itself (Open/Closed).
 *
 * find_tool searches a cached tool_catalog (semantic similarity via `embedder`, not
 * connecting to anything) rather than a live connection — see DESIGN.md's backlog entry
 * on this. A server with no cache yet gets one built lazily (the only time find_tool
 * connects to anything); call_tool is otherwise the only thing that ever connects, and
 * only to the one server it actually needs.
 */

/** Single source of truth for every meta-tool's name — referenced by both the tool
 *  schemas below and handleMetaToolCall's dispatch, so the two can never drift apart. */
const MetaTool = {
  FindTool: "find_tool",
  CallTool: "call_tool",
  ListServices: "list_services",
  RegisterMyCredential: "register_my_credential",
  ManageRoles: "manage_roles",
} as const;

/** ✅ configured and usable, ❌ permitted but still needs a credential from you, 🚫 not
 *  even permitted yet (ask an admin) — see SelfServiceHandler.ServiceStatus. */
const SERVICE_STATUS_ICON: Record<"ready" | "needs_credential" | "not_permitted", string> = {
  ready: "✅",
  needs_credential: "❌",
  not_permitted: "🚫",
};

export interface DiscoveredTool {
  readonly server: string;
  readonly name: string;
  readonly description: string;
}

const CORE_TOOLS = [
  {
    name: MetaTool.FindTool,
    description:
      "Search for available tools across every server you have access to. Call this first " +
      "to discover what you can do, then call call_tool with the exact server/tool it returns.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Keyword(s) to search for, or empty to list everything" } },
    },
  },
  {
    name: MetaTool.CallTool,
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

const SELF_SERVICE_TOOLS = [
  {
    name: MetaTool.ListServices,
    description:
      "See every registered server and your status for each: \"ready\" (you have a working credential), " +
      "\"needs_credential\" (you're permitted but haven't configured one yet — use register_my_credential), " +
      "or \"not_permitted\" (ask an admin to grant your role access first).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: MetaTool.RegisterMyCredential,
    description:
      "Set your own credential for a server you already have permission on (see list_services). " +
      "Never grants permission itself — only an admin can do that.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "The server name from list_services" },
        env: { type: "object", description: "Every env var the server needs, e.g. {\"API_TOKEN\": \"...\"}" },
      },
      required: ["server", "env"],
    },
  },
] as const;

const ADMIN_TOOLS = [
  {
    name: MetaTool.ManageRoles,
    description:
      "Admin-only: manage roles, role assignments, users, and stored credentials. " +
      "Actions: create_role({name, isAdmin}), delete_role({name}), assign_role({userName, roleName}), " +
      "unassign_role({userName, roleName}), list_roles(), list_users(), delete_user({userName}), " +
      "delete_credential({userName, serverName}), refresh_catalog({serverName}).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        name: { type: "string" },
        isAdmin: { type: "boolean" },
        userName: { type: "string" },
        roleName: { type: "string" },
        serverName: { type: "string" },
      },
      required: ["action"],
    },
  },
] as const;

function isPermitted(allowed: AllowedTools, toolName: string): boolean {
  return allowed === "all" || allowed.has(toolName);
}

interface RankedTool {
  readonly discovered: DiscoveredTool;
  readonly similarity: number;
}

export class ToolDiscoveryRouter {
  constructor(
    private readonly handlers: readonly ToolCallHandler[],
    /** Only needed to audit calls to a server this identity was never even connected to
     *  (see callTool below) — every other audit entry is written by the per-server
     *  ToolCallHandler that already owns identity/audit wiring for its own server. */
    private readonly identity: Identity,
    private readonly auditLog: AuditLogRepository,
    private readonly selfService: SelfServiceHandler,
    private readonly toolCatalog: ToolCatalogRepository,
    private readonly embedder: Embedder,
    /** Present only for identities whose user holds an admin role — deciding that is the
     *  composition root's job (see this class's own docstring), not this router's. */
    private readonly adminHandler: AdminToolHandler | undefined = undefined,
    /** Injectable so tests get deterministic, non-flaky duration_ms values — same pattern
     *  as ToolCallHandler's own clock. */
    private readonly now: () => number = Date.now,
  ) {}

  listMetaTools(): { tools: unknown[] } {
    return { tools: [...CORE_TOOLS, ...SELF_SERVICE_TOOLS, ...(this.adminHandler ? ADMIN_TOOLS : [])] };
  }

  /** Searches every accessible server's CACHED tool catalog by semantic similarity to
   *  `query`, then drops anything this identity couldn't actually call — discovery is
   *  exactly as strict as calling, never a way to enumerate tools you have no access to.
   *  A non-empty query returns at most MAX_FIND_TOOL_RESULTS, ranked highest-similarity
   *  first ACROSS every server combined (see that constant's docstring for why this is
   *  a top-K, not a similarity threshold) — an empty query returns everything permitted,
   *  unranked and uncapped, since there's no relevance signal to rank by.
   *
   *  Every server is processed in parallel (Promise.all) rather than one at a time, so
   *  total latency is bounded by the slowest single server, not the sum of all of them —
   *  same as before this searched a cache instead of a live connection. A server with no
   *  cached entries yet is the only case that actually connects here (see catalogFor); a
   *  connection failure only drops that one server's results, never the whole search. */
  async findTool(query: string): Promise<DiscoveredTool[]> {
    const term = query.trim();
    const queryEmbedding = term ? await this.embedder.embed(term) : undefined;

    const perServerMatches = await Promise.all(
      this.handlers.map(async (handler): Promise<RankedTool[]> => {
        try {
          const [entries, allowed] = await Promise.all([this.catalogFor(handler), handler.getAllowedToolNames()]);
          return entries
            .filter((entry) => isPermitted(allowed, entry.toolName))
            .map((entry) => ({
              discovered: { server: handler.serverName, name: entry.toolName, description: entry.description },
              similarity: queryEmbedding ? cosineSimilarity(entry.embedding, queryEmbedding) : 0,
            }));
        } catch (error) {
          console.error(`[mcp-trust-gateway] Could not search server "${handler.serverName}" — skipping it for this query:`, error);
          return [];
        }
      }),
    );

    const allMatches = perServerMatches.flat();
    if (!queryEmbedding) return allMatches.map((match) => match.discovered);

    return allMatches
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, MAX_FIND_TOOL_RESULTS)
      .map((match) => match.discovered);
  }

  /** Routes to the ToolCallHandler for `server` — permission check, forwarding, and
   *  auditing all happen inside that handler exactly as they already did pre-Phase-2. If
   *  `server` isn't one this identity is even permitted on, that's still a real access
   *  attempt worth a "complete audit trail of every decision" claim actually meaning
   *  something — logged here directly, since there's no per-server ToolCallHandler to do
   *  it (the gateway process never had reason to build one for a server this identity
   *  has zero grants on in the first place).
   *
   *  A stale/missing catalog entry for this server is refreshed in the background,
   *  reusing whatever connection this call itself opens — never blocks the actual call
   *  on a catalog refresh, and never opens a second connection just to refresh. */
  async callTool(server: string, tool: string, args: unknown): Promise<ToolCallResult> {
    const startedAt = this.now();
    const handler = this.handlers.find((h) => h.serverName === server);
    if (!handler) {
      await this.auditLog.write({
        identityId: this.identity.id,
        serverName: server,
        toolName: tool,
        paramsRedacted: redact(args ?? {}),
        status: AuditStatus.Denied,
        resultSummary: `Denied: identity "${this.identity.name}" has no access to server "${server}" (unknown or unpermitted).`,
        durationMs: this.now() - startedAt,
      });
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown server "${server}". Call find_tool first to see what's available.` }],
      };
    }

    void this.refreshCatalogIfStale(handler).catch((error: unknown) => {
      console.error(`[mcp-trust-gateway] Background tool-catalog refresh failed for "${server}":`, error);
    });

    return handler.callTool(tool, args);
  }

  /** Returns this server's cached catalog, building it first if it's never been
   *  cataloged at all (the only case where find_tool itself connects to anything). A
   *  real server that genuinely exposes zero tools is indistinguishable from "never
   *  cataloged" here (both are an empty array) — an accepted, deliberate simplification;
   *  see ports/ToolCatalogRepository.ts. */
  private async catalogFor(handler: ToolCallHandler): Promise<ToolCatalogEntry[]> {
    const cached = await this.toolCatalog.findByServer(handler.server.id);
    if (cached.length > 0) return cached;
    await this.rebuildCatalog(handler);
    return this.toolCatalog.findByServer(handler.server.id);
  }

  private async refreshCatalogIfStale(handler: ToolCallHandler): Promise<void> {
    const entries = await this.toolCatalog.findByServer(handler.server.id);
    const isStale = entries.length === 0 || this.now() - entries[0].refreshedAt.getTime() > TOOL_CATALOG_TTL_MS;
    if (isStale) await this.rebuildCatalog(handler);
  }

  private async rebuildCatalog(handler: ToolCallHandler): Promise<void> {
    const summaries = extractToolSummaries(await handler.listTools());
    const entries: NewToolCatalogEntry[] = await Promise.all(
      summaries.map(async (tool) => ({
        toolName: tool.name,
        description: tool.description,
        embedding: await this.embedder.embed(`${tool.name}: ${tool.description}`),
      })),
    );
    await this.toolCatalog.replaceForServer(handler.server.id, entries);
  }

  /** The one entry point the composition root needs for tools/call — dispatches by name
   *  and formats the response as an MCP tool result. Kept here rather than in index.ts
   *  because "how does a meta-tool call turn into a response" is this router's concern,
   *  not composition-root wiring. */
  async handleMetaToolCall(name: string, args: unknown): Promise<ToolCallResult> {
    const params = (args ?? {}) as Record<string, unknown>;

    if (name === MetaTool.FindTool) {
      const query = typeof params.query === "string" ? params.query : "";
      const results = await this.findTool(query);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }

    if (name === MetaTool.CallTool) {
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

    if (name === MetaTool.ListServices) {
      const services = await this.selfService.listServices();
      // A `display` field alongside the machine-readable `status` — a quick ✅/❌/🚫 glance
      // for whoever's actually reading this (a human via their agent), without changing
      // `status`'s own values, which existing callers may already depend on verbatim.
      const withDisplay = services.map((s) => ({ ...s, display: `${SERVICE_STATUS_ICON[s.status]} ${s.server}` }));
      return { content: [{ type: "text", text: JSON.stringify(withDisplay, null, 2) }] };
    }

    if (name === MetaTool.RegisterMyCredential) {
      const server = typeof params.server === "string" ? params.server : undefined;
      const env = params.env && typeof params.env === "object" ? (params.env as Record<string, string>) : undefined;
      if (!server || !env) {
        return { isError: true, content: [{ type: "text", text: 'register_my_credential requires "server" and "env".' }] };
      }
      return this.selfService.registerMyCredential(server, env);
    }

    if (name === MetaTool.ManageRoles) {
      if (!this.adminHandler) {
        return { isError: true, content: [{ type: "text", text: "manage_roles is only available to admins." }] };
      }
      const action = typeof params.action === "string" ? params.action : "";
      return this.adminHandler.handle(action, params);
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool "${name}". Call find_tool first to see what's available.` }],
    };
  }
}
