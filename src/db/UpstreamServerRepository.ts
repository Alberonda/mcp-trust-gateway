import type { Queryable } from "./Queryable.js";
import type { EncryptedUpstreamCredential, UpstreamServer } from "./types.js";

/** What registering a new server needs — the same {command, args, env} shape every MCP
 *  client config already uses. `encryptedEnv` is passed already-encrypted (see
 *  CredentialVault) — this repository only persists it, it never handles plaintext
 *  secrets or decides how to encrypt them; that stays the composition root/script's job,
 *  consistent with every other repository in this codebase. */
export interface NewUpstreamServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly encryptedEnv?: EncryptedUpstreamCredential;
}

export interface UpstreamServerRepository {
  findByName(name: string): Promise<UpstreamServer | null>;
  /** Used by the composition root to resolve every server an identity has any permission
   *  on (see PermissionRepository.findAccessibleServerIds) into the details needed to
   *  actually connect to each one. Empty input returns an empty array without a query. */
  findManyByIds(ids: readonly string[]): Promise<UpstreamServer[]>;

  /** Registers a new upstream server — see NewUpstreamServer for why this mirrors
   *  standard MCP client config shape directly. */
  create(server: NewUpstreamServer): Promise<UpstreamServer>;

  /** Rotates every env var for an existing server in place — same id/name/command/args,
   *  only the encrypted env map changes. Keeping the id stable means every existing
   *  permission grant for this server keeps working without needing to be re-created;
   *  only whoever connects afterwards gets the new values. Throws if serverId doesn't
   *  exist, since a silent no-op there would be a confusing way to fail. */
  updateEnv(serverId: string, encryptedEnv: EncryptedUpstreamCredential): Promise<void>;
}

interface UpstreamServerRow {
  id: string;
  name: string;
  command: string;
  args: string[];
  encryptedCredential: Buffer | null;
  credentialIv: Buffer | null;
  credentialAuthTag: Buffer | null;
}

const UPSTREAM_SERVER_COLUMNS = `
  id, name, command, args,
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
    args: row.args,
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

  async create(server: NewUpstreamServer): Promise<UpstreamServer> {
    const { rows } = await this.db.query<UpstreamServerRow>(
      `INSERT INTO upstream_servers (name, command, args, encrypted_credential, credential_iv, credential_auth_tag)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${UPSTREAM_SERVER_COLUMNS}`,
      [
        server.name,
        server.command,
        JSON.stringify(server.args),
        server.encryptedEnv?.ciphertext ?? null,
        server.encryptedEnv?.iv ?? null,
        server.encryptedEnv?.authTag ?? null,
      ],
    );
    return mapRow(rows[0]);
  }

  async updateEnv(serverId: string, encryptedEnv: EncryptedUpstreamCredential): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE upstream_servers
       SET encrypted_credential = $2, credential_iv = $3, credential_auth_tag = $4
       WHERE id = $1
       RETURNING id`,
      [serverId, encryptedEnv.ciphertext, encryptedEnv.iv, encryptedEnv.authTag],
    );
    if (rows.length === 0) {
      throw new Error(`No upstream server with id "${serverId}" — cannot rotate env vars for a server that doesn't exist.`);
    }
  }
}
