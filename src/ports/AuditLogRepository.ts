import type { AuditStatus } from "../domain/constants.js";

export interface AuditEntry {
  readonly identityId: string | null;
  readonly serverName: string;
  readonly toolName: string;
  readonly paramsRedacted: unknown;
  readonly status: AuditStatus;
  readonly resultSummary: string;
  readonly durationMs: number;
}

export interface StoredAuditEntry extends AuditEntry {
  readonly id: number;
  readonly createdAt: Date;
}

/** search()'s result also carries the identity's human-readable name — a CLI/viewer has
 *  no other reasonable way to show "who did this" without a UUID lookup of its own. */
export interface AuditLogRow extends StoredAuditEntry {
  readonly identityName: string | null;
}

/** Every filter is optional — omitting all of them returns the N most recent entries
 *  across every identity, which is what a general-purpose viewer needs that
 *  findRecentByIdentity (below) was never meant to support. */
export interface AuditSearchFilters {
  readonly identityName?: string;
  readonly serverName?: string;
  readonly status?: AuditStatus;
  readonly limit: number;
}

export interface AuditLogRepository {
  write(entry: AuditEntry): Promise<void>;
  /** Most recent entries for one identity, newest first — the minimal read path
   *  ToolCallHandler's own tests need to verify what write() actually persisted. */
  findRecentByIdentity(identityId: string, limit: number): Promise<StoredAuditEntry[]>;
  /** General-purpose query for scripts/view_audit_log.ts (Phase 3d) — filter by any
   *  combination of identity name, server, and status, or none at all. */
  search(filters: AuditSearchFilters): Promise<AuditLogRow[]>;
}
