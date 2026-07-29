import type { Queryable } from "./Queryable.js";
import type { Identity } from "./types.js";

/** ToolCallHandler depends on this interface, never on Postgres directly — that's what
 *  lets tests substitute an in-memory fake with zero database involved. */
export interface IdentityRepository {
  findByApiKeyHash(hash: string): Promise<Identity | null>;
}

export class PostgresIdentityRepository implements IdentityRepository {
  constructor(private readonly db: Queryable) {}

  async findByApiKeyHash(hash: string): Promise<Identity | null> {
    const { rows } = await this.db.query<Identity>(
      `SELECT id, name, api_key_hash AS "apiKeyHash", is_active AS "isActive"
       FROM identities WHERE api_key_hash = $1 AND is_active = true`,
      [hash],
    );
    return rows[0] ?? null;
  }
}
