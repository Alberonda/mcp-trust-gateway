import { AuditStatus } from "../constants.js";
import type { AuditLogRepository } from "../db/AuditLogRepository.js";
import type { PermissionRepository } from "../db/PermissionRepository.js";
import type { Identity, UpstreamServer } from "../db/types.js";
import { redact } from "../redact.js";
import { summarizeResult } from "./summarizeResult.js";
import type { ToolCallResult, UpstreamToolClient } from "./UpstreamToolClient.js";

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
    private readonly upstreamClient: UpstreamToolClient,
    /** Injectable so tests get deterministic, non-flaky duration_ms values. */
    private readonly now: () => number = Date.now,
  ) {}

  /** Which upstream server this handler talks to — used by ToolDiscoveryRouter to label
   *  discovered tools and to route call_tool requests to the right handler. */
  get serverName(): string {
    return this.upstreamServer.name;
  }

  /** tools/list itself is not permission-gated at this level — knowing a tool exists is
   *  not the same as being allowed to call it. ToolDiscoveryRouter is what actually
   *  enforces per-tool visibility during discovery, via isToolAllowed() below. */
  async listTools(): Promise<unknown> {
    return this.upstreamClient.listTools();
  }

  /** Would callTool(toolName, ...) be allowed right now, without actually calling or
   *  auditing anything? Used by ToolDiscoveryRouter to filter find_tool results down to
   *  only what this identity could actually call — so discovery is exactly as strict as
   *  calling, never a way to enumerate tools you have no access to. */
  async isToolAllowed(toolName: string): Promise<boolean> {
    return this.permissions.isCallAllowed(this.identity.id, this.upstreamServer.id, toolName);
  }

  async callTool(toolName: string, args: unknown): Promise<ToolCallResult> {
    const startedAt = this.now();
    const redactedParams = redact(args ?? {});

    const allowed = await this.permissions.isCallAllowed(this.identity.id, this.upstreamServer.id, toolName);
    if (!allowed) {
      return this.denyAndAudit(toolName, redactedParams, startedAt);
    }

    try {
      const result = await this.upstreamClient.callTool(toolName, args);
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
