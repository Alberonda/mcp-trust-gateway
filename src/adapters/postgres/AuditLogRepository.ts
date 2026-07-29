import type { AuditStatus } from "../../domain/constants.js";
import type { AuditEntry, AuditLogRepository, AuditLogRow, AuditSearchFilters, StoredAuditEntry } from "../../ports/AuditLogRepository.js";
import type { Queryable } from "../../ports/Queryable.js";

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

  async search(filters: AuditSearchFilters): Promise<AuditLogRow[]> {
    const { rows } = await this.db.query<AuditLogRow>(
      `SELECT audit_log.id, audit_log.identity_id AS "identityId", identities.name AS "identityName",
              audit_log.server_name AS "serverName", audit_log.tool_name AS "toolName",
              audit_log.params_redacted AS "paramsRedacted", audit_log.status,
              audit_log.result_summary AS "resultSummary", audit_log.duration_ms AS "durationMs",
              audit_log.created_at AS "createdAt"
       FROM audit_log
       LEFT JOIN identities ON identities.id = audit_log.identity_id
       WHERE ($1::text IS NULL OR identities.name = $1)
         AND ($2::text IS NULL OR audit_log.server_name = $2)
         AND ($3::text IS NULL OR audit_log.status = $3)
       ORDER BY audit_log.created_at DESC, audit_log.id DESC
       LIMIT $4`,
      [filters.identityName ?? null, filters.serverName ?? null, filters.status ?? null, filters.limit],
    );
    return rows;
  }
}
