import { AuditStatus } from "./constants.js";
import type { AuditLogRepository } from "../ports/AuditLogRepository.js";
import type { AllowedTools, PermissionRepository } from "../ports/PermissionRepository.js";
import type { Identity, UpstreamServer } from "./types.js";
import { redact } from "./redact.js";
import { summarizeResult } from "./summarizeResult.js";
import type { ToolCallResult, UpstreamToolClient } from "../ports/UpstreamToolClient.js";

/**
 * The actual policy this whole project exists for: check permission, forward the call
 * (or don't), write an audited record of what happened either way. Everything it depends
 * on is an interface (constructor-injected), so this class can be fully exercised in a
 * unit test with in-memory fakes — no Postgres, no MCP subprocess, no network.
 */
export class ToolCallHandler {
  constructor(
    private readonly identity: Identity,
    private readonly upstreamServer: UpstreamServer,
    private readonly permissions: PermissionRepository,
    private readonly auditLog: AuditLogRepository,
    /** Connects on first use and is expected to memoize the result itself (see
     *  domain/buildAccessibleServerHandlers.ts) — NOT called at all for a denied
     *  callTool(), which is the entire point of deferring connection to here instead
     *  of connecting every accessible server up front regardless of whether a given
     *  session ever uses it. */
    private readonly connectClient: () => Promise<UpstreamToolClient>,
    /** Injectable so tests get deterministic, non-flaky duration_ms values. */
    private readonly now: () => number = Date.now,
  ) {}

  /** Which upstream server this handler talks to — used by ToolDiscoveryRouter to label
   *  discovered tools and to route call_tool requests to the right handler. */
  get serverName(): string {
    return this.upstreamServer.name;
  }

  /** Which upstream server this handler talks to, in full — ToolDiscoveryRouter needs
   *  the id (not just the name) to look up/refresh this server's tool_catalog entry. */
  get server(): UpstreamServer {
    return this.upstreamServer;
  }

  /** tools/list itself is not permission-gated at this level — knowing a tool exists is
   *  not the same as being allowed to call it. ToolDiscoveryRouter is what actually
   *  enforces per-tool visibility during discovery, via getAllowedToolNames() below.
   *  Connects (or reuses the already-open connection) — the one caller of this,
   *  ToolDiscoveryRouter's catalog-building, only calls it when it actually needs to. */
  async listTools(): Promise<unknown> {
    const client = await this.connectClient();
    return client.listTools();
  }

  /** Every tool this identity may call on this server, in one query — used by
   *  ToolDiscoveryRouter to filter a whole find_tool candidate list at once instead of
   *  querying isCallAllowed once per candidate tool (which would cost one Postgres round
   *  trip per tool across every connected server on every discovery call). Discovery ends
   *  up exactly as strict as calling, never a way to enumerate tools you have no access
   *  to — just resolved with O(servers) queries instead of O(servers × tools). */
  async getAllowedToolNames(): Promise<AllowedTools> {
    return this.permissions.findAllowedToolNames(this.identity.userId, this.upstreamServer.id);
  }

  async callTool(toolName: string, args: unknown): Promise<ToolCallResult> {
    const startedAt = this.now();
    const redactedParams = redact(args ?? {});

    // Permission checks operate on userId — every identity (API key/session) belonging
    // to the same user shares the same grants. audit_log below still records this.identity.id,
    // not userId, since knowing *which specific credential* made a call is more forensically
    // useful than only knowing which user it belonged to.
    const allowed = await this.permissions.isCallAllowed(this.identity.userId, this.upstreamServer.id, toolName);
    if (!allowed) {
      return this.denyAndAudit(toolName, redactedParams, startedAt);
    }

    try {
      const client = await this.connectClient();
      const result = await client.callTool(toolName, args);
      await this.auditLog.write({
        identityId: this.identity.id,
        serverName: this.upstreamServer.name,
        toolName,
        paramsRedacted: redactedParams,
        status: result.isError ? AuditStatus.AllowedFailure : AuditStatus.AllowedSuccess,
        resultSummary: summarizeResult(result),
        durationMs: this.now() - startedAt,
      });
      return result;
    } catch (error) {
      await this.auditLog.write({
        identityId: this.identity.id,
        serverName: this.upstreamServer.name,
        toolName,
        paramsRedacted: redactedParams,
        status: AuditStatus.AllowedFailure,
        resultSummary: error instanceof Error ? error.message : String(error),
        durationMs: this.now() - startedAt,
      });
      throw error;
    }
  }

  private async denyAndAudit(toolName: string, redactedParams: unknown, startedAt: number): Promise<ToolCallResult> {
    await this.auditLog.write({
      identityId: this.identity.id,
      serverName: this.upstreamServer.name,
      toolName,
      paramsRedacted: redactedParams,
      status: AuditStatus.Denied,
      resultSummary: `Denied: identity "${this.identity.name}" has no permission for this tool.`,
      durationMs: this.now() - startedAt,
    });
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Permission denied: "${this.identity.name}" cannot call "${toolName}" on "${this.upstreamServer.name}".`,
        },
      ],
    };
  }
}
