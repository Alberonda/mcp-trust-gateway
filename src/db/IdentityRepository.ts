import type { Queryable } from "./Queryable.js";
import type { Identity } from "./types.js";

/** ToolCallHandler depends on this interface, never on Postgres directly — that's what
 *  lets tests substitute an in-memory fake with zero database involved. */
export interface IdentityRepository {
  findByApiKeyHash(hash: string): Promise<Identity | null>;

  /** Resolves the identity a session token was issued for (see SessionRepository) —
   *  sessions store an identityId, not a full Identity, so this is how HTTP mode turns
   *  "which session is this" back into the Identity object ToolCallHandler/
   *  ToolDiscoveryRouter already know how to work with. */
  findById(id: string): Promise<Identity | null>;
}

export class PostgresIdentityRepository implements IdentityRepository {
  constructor(private readonly db: Queryable) {}

  async findByApiKeyHash(hash: string): Promise<Identity | null> {
    const { rows } = await this.db.query<Identity>(
      `SELECT id, user_id AS "userId", name, api_key_hash AS "apiKeyHash", is_active AS "isActive"
       FROM identities WHERE api_key_hash = $1 AND is_active = true`,
      [hash],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<Identity | null> {
    const { rows } = await this.db.query<Identity>(
      `SELECT id, user_id AS "userId", name, api_key_hash AS "apiKeyHash", is_active AS "isActive"
       FROM identities WHERE id = $1 AND is_active = true`,
      [id],
    );
    return rows[0] ?? null;
  }
}
