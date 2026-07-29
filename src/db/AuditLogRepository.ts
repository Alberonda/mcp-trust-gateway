import type { AuditStatus } from "../constants.js";
import type { Queryable } from "./Queryable.js";

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

export interface AuditLogRepository {
  write(entry: AuditEntry): Promise<void>;
  /** Most recent entries for one identity, newest first — the minimal read path needed
   *  to verify what write() actually persisted. A real query/filter UI is Phase 2. */
  findRecentByIdentity(identityId: string, limit: number): Promise<StoredAuditEntry[]>;
}

export class PostgresAuditLogRepository implements AuditLogRepository {
  constructor(private readonly db: Queryable) {}

  async write(entry: AuditEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_log
         (identity_id, server_name, tool_name, params_redacted, status, result_summary, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.identityId,
        entry.serverName,
        entry.toolName,
        JSON.stringify(entry.paramsRedacted),
        entry.status,
        entry.resultSummary,
        entry.durationMs,
      ],
    );
  }

  /** Ordered by created_at DESC with `id DESC` as a tiebreaker — Postgres's now() is fixed
   *  for the entire duration of a transaction, so several writes in one transaction (or
   *  just several writes landing in the same timestamp precision window) would otherwise
   *  sort in an unspecified order relative to each other. Caught by the integration test
   *  for this method, not by the unit tests (which use an in-memory fake with no real
   *  clock/transaction semantics to expose the bug). */
  async findRecentByIdentity(identityId: string, limit: number): Promise<StoredAuditEntry[]> {
    const { rows } = await this.db.query<{
      id: number;
      identityId: string | null;
      serverName: string;
      toolName: string;
      paramsRedacted: unknown;
      status: AuditStatus;
      resultSummary: string;
      durationMs: number;
      createdAt: Date;
    }>(
      `SELECT id, identity_id AS "identityId", server_name AS "serverName", tool_name AS "toolName",
              params_redacted AS "paramsRedacted", status, result_summary AS "resultSummary",
              duration_ms AS "durationMs", created_at AS "createdAt"
       FROM audit_log WHERE identity_id = $1
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      [identityId, limit],
    );
    return rows;
  }
}
