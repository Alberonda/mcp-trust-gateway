import type { Queryable } from "./Queryable.js";
import type { EncryptedUpstreamCredential, UpstreamServer } from "./types.js";

export interface UpstreamServerRepository {
  findByName(name: string): Promise<UpstreamServer | null>;
  /** Used by the composition root to resolve every server an identity has any permission
   *  on (see PermissionRepository.findAccessibleServerIds) into the details needed to
   *  actually connect to each one. Empty input returns an empty array without a query. */
  findManyByIds(ids: readonly string[]): Promise<UpstreamServer[]>;

  /** Rotates the credential for an existing server in place — same id/name/command, only
   *  the encrypted secret changes. Keeping the id stable means every existing permission
   *  grant for this server keeps working without needing to be re-created; only whoever
   *  connects to the server afterwards gets the new credential. Throws if serverId
   *  doesn't exist, since a silent no-op there would be a confusing way to fail. */
  updateCredential(serverId: string, credential: EncryptedUpstreamCredential): Promise<void>;
}

interface UpstreamServerRow {
  id: string;
  name: string;
  command: string;
  encryptedCredential: Buffer | null;
  credentialIv: Buffer | null;
  credentialAuthTag: Buffer | null;
}

const UPSTREAM_SERVER_COLUMNS = `
  id, name, command,
  encrypted_credential AS "encryptedCredential",
  credential_iv AS "credentialIv",
  credential_auth_tag AS "credentialAuthTag"
`;

function mapRow(row: UpstreamServerRow): UpstreamServer {
  const hasCredential = row.encryptedCredential && row.credentialIv && row.credentialAuthTag;
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    credential: hasCredential
      ? { ciphertext: row.encryptedCredential!, iv: row.credentialIv!, authTag: row.credentialAuthTag! }
      : null,
  };
}

export class PostgresUpstreamServerRepository implements UpstreamServerRepository {
  constructor(private readonly db: Queryable) {}

  async findByName(name: string): Promise<UpstreamServer | null> {
    const { rows } = await this.db.query<UpstreamServerRow>(
      `SELECT ${UPSTREAM_SERVER_COLUMNS} FROM upstream_servers WHERE name = $1`,
      [name],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findManyByIds(ids: readonly string[]): Promise<UpstreamServer[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.db.query<UpstreamServerRow>(
      `SELECT ${UPSTREAM_SERVER_COLUMNS} FROM upstream_servers WHERE id = ANY($1)`,
      [ids],
    );
    return rows.map(mapRow);
  }

  async updateCredential(serverId: string, credential: EncryptedUpstreamCredential): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE upstream_servers
       SET encrypted_credential = $2, credential_iv = $3, credential_auth_tag = $4
       WHERE id = $1
       RETURNING id`,
      [serverId, credential.ciphertext, credential.iv, credential.authTag],
    );
    if (rows.length === 0) {
      throw new Error(`No upstream server with id "${serverId}" — cannot rotate a credential for a server that doesn't exist.`);
    }
  }
}
