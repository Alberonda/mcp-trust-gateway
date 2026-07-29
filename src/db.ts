import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | undefined;

/** Lazily-created singleton pool, reused across the process lifetime. */
export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set.");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

export interface Identity {
  id: string;
  name: string;
  apiKeyHash: string;
  isActive: boolean;
}

export async function findIdentityByApiKeyHash(hash: string): Promise<Identity | null> {
  const { rows } = await getPool().query(
    `SELECT id, name, api_key_hash AS "apiKeyHash", is_active AS "isActive"
     FROM identities WHERE api_key_hash = $1 AND is_active = true`,
    [hash],
  );
  return rows[0] ?? null;
}

export interface UpstreamServer {
  id: string;
  name: string;
  command: string;
  encryptedCredential: Buffer | null;
  credentialIv: Buffer | null;
  credentialAuthTag: Buffer | null;
}

export async function findUpstreamServerByName(name: string): Promise<UpstreamServer | null> {
  const { rows } = await getPool().query(
    `SELECT id, name, command,
            encrypted_credential AS "encryptedCredential",
            credential_iv AS "credentialIv",
            credential_auth_tag AS "credentialAuthTag"
     FROM upstream_servers WHERE name = $1`,
    [name],
  );
  return rows[0] ?? null;
}

/** True if the identity is allowed to call toolName on serverId (or has a blanket NULL-tool grant). */
export async function isCallAllowed(
  identityId: string,
  serverId: string,
  toolName: string,
): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM permissions
     WHERE identity_id = $1 AND server_id = $2 AND (tool_name = $3 OR tool_name IS NULL)
     LIMIT 1`,
    [identityId, serverId, toolName],
  );
  return rows.length > 0;
}

export type AuditStatus = "allowed_success" | "allowed_failure" | "denied";

export interface AuditEntry {
  identityId: string | null;
  serverName: string;
  toolName: string;
  paramsRedacted: unknown;
  status: AuditStatus;
  resultSummary: string;
  durationMs: number;
}

export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  await getPool().query(
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
