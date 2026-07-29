import type { Queryable } from "./Queryable.js";
import type { EncryptedUpstreamCredential } from "./types.js";

/**
 * Every credential for talking to a real upstream server — per (user, server), with no
 * server-level default anywhere else to fall back to (see
 * migrations/006_remove_shared_upstream_credential.sql). Every user, including whoever
 * first registers a server, stores their own credential here the same way — there is no
 * privileged "default" user.
 */
export interface UserCredentialRepository {
  /** This user's own credential for this server, or null if they have none (they simply
   *  can't use this server if it needs one — there is nothing to fall back to). */
  find(userId: string, serverId: string): Promise<EncryptedUpstreamCredential | null>;

  /** Sets (or replaces) this user's own credential for this server. */
  upsert(userId: string, serverId: string, credential: EncryptedUpstreamCredential): Promise<void>;

  /** Removes this user's credential for this server. Idempotent — removing a row that
   *  doesn't exist is not an error. */
  remove(userId: string, serverId: string): Promise<void>;
}

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
