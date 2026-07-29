import type { Identity } from "../../domain/types.js";
import type { IdentityRepository } from "../../ports/IdentityRepository.js";
import type { Queryable } from "../../ports/Queryable.js";

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
