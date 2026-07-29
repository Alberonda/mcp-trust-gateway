import type pg from "pg";
import type { AuditStatus } from "../constants.js";

export interface AuditEntry {
  readonly identityId: string | null;
  readonly serverName: string;
  readonly toolName: string;
  readonly paramsRedacted: unknown;
  readonly status: AuditStatus;
  readonly resultSummary: string;
  readonly durationMs: number;
}

export interface AuditLogRepository {
  write(entry: AuditEntry): Promise<void>;
}

export class PostgresAuditLogRepository implements AuditLogRepository {
  constructor(private readonly pool: pg.Pool) {}

  async write(entry: AuditEntry): Promise<void> {
    await this.pool.query(
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
}
