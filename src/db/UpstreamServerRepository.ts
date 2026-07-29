import type pg from "pg";
import type { UpstreamServer } from "./types.js";

export interface UpstreamServerRepository {
  findByName(name: string): Promise<UpstreamServer | null>;
}

export class PostgresUpstreamServerRepository implements UpstreamServerRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findByName(name: string): Promise<UpstreamServer | null> {
    const { rows } = await this.pool.query<{
      id: string;
      name: string;
      command: string;
      encryptedCredential: Buffer | null;
      credentialIv: Buffer | null;
      credentialAuthTag: Buffer | null;
    }>(
      `SELECT id, name, command,
              encrypted_credential AS "encryptedCredential",
              credential_iv AS "credentialIv",
              credential_auth_tag AS "credentialAuthTag"
       FROM upstream_servers WHERE name = $1`,
      [name],
    );
    const row = rows[0];
    if (!row) return null;

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
}
