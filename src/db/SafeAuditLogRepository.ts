import type { AuditEntry, AuditLogRepository, AuditLogRow, AuditSearchFilters, StoredAuditEntry } from "./AuditLogRepository.js";

/**
 * Wraps any AuditLogRepository so a failure to *write* an audit entry can never surface as
 * an error to callers like ToolCallHandler.callTool() or ToolDiscoveryRouter.callTool().
 *
 * Without this: if a real upstream tool call succeeds and the audit write that follows it
 * then throws (e.g. a transient Postgres blip), that exception propagates out of callTool()
 * exactly as if the *tool call itself* had failed — the agent sees an error for an action
 * that actually happened, and may retry it. For a non-idempotent action (a file write, a
 * message sent, a record deleted), that's a real correctness bug, not a cosmetic one.
 *
 * Reads (findRecentByIdentity) are deliberately NOT swallowed here — a failed read doesn't
 * create any ambiguity about whether some other action succeeded, so there's no reason to
 * hide it from the caller.
 */
export class SafeAuditLogRepository implements AuditLogRepository {
  constructor(
    private readonly inner: AuditLogRepository,
    /** Injectable so tests can assert on what gets logged instead of depending on
     *  console.error's real output. */
    private readonly onWriteFailure: (error: unknown, entry: AuditEntry) => void = defaultOnWriteFailure,
  ) {}

  async write(entry: AuditEntry): Promise<void> {
    try {
      await this.inner.write(entry);
    } catch (error) {
      this.onWriteFailure(error, entry);
    }
  }

  async findRecentByIdentity(identityId: string, limit: number): Promise<StoredAuditEntry[]> {
    return this.inner.findRecentByIdentity(identityId, limit);
  }

  async search(filters: AuditSearchFilters): Promise<AuditLogRow[]> {
    return this.inner.search(filters);
  }
}

function defaultOnWriteFailure(error: unknown, entry: AuditEntry): void {
  console.error("[mcp-trust-gateway] Failed to write audit log entry (the underlying action still completed):", {
    error,
    entry,
  });
}
