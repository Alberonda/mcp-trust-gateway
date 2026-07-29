import type { EncryptedUpstreamCredential } from "../../domain/types.js";
import type { UserCredentialRepository } from "../../ports/UserCredentialRepository.js";
import type { Queryable } from "../../ports/Queryable.js";

interface UserCredentialRow {
  encryptedCredential: Buffer;
  credentialIv: Buffer;
  credentialAuthTag: Buffer;
}

export class PostgresUserCredentialRepository implements UserCredentialRepository {
  constructor(private readonly db: Queryable) {}

  async find(userId: string, serverId: string): Promise<EncryptedUpstreamCredential | null> {
    const { rows } = await this.db.query<UserCredentialRow>(
      `SELECT encrypted_credential AS "encryptedCredential",
              credential_iv AS "credentialIv",
              credential_auth_tag AS "credentialAuthTag"
       FROM user_credentials WHERE user_id = $1 AND server_id = $2`,
      [userId, serverId],
    );
    const row = rows[0];
    return row ? { ciphertext: row.encryptedCredential, iv: row.credentialIv, authTag: row.credentialAuthTag } : null;
  }

  async upsert(userId: string, serverId: string, credential: EncryptedUpstreamCredential): Promise<void> {
    await this.db.query(
      `INSERT INTO user_credentials (user_id, server_id, encrypted_credential, credential_iv, credential_auth_tag)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, server_id)
       DO UPDATE SET encrypted_credential = $3, credential_iv = $4, credential_auth_tag = $5`,
      [userId, serverId, credential.ciphertext, credential.iv, credential.authTag],
    );
  }

  async remove(userId: string, serverId: string): Promise<void> {
    await this.db.query(`DELETE FROM user_credentials WHERE user_id = $1 AND server_id = $2`, [userId, serverId]);
  }
}
