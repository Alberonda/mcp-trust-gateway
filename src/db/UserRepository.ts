import type { Queryable } from "./Queryable.js";
import type { User } from "./types.js";

export interface UserRepository {
  create(name: string): Promise<User>;
  findById(id: string): Promise<User | null>;
  findByName(name: string): Promise<User | null>;
  listAll(): Promise<User[]>;
  /** Cascades to identities/user_roles/user_credentials referencing this user (see their
   *  ON DELETE CASCADE foreign keys) — removing a user removes their access entirely, not
   *  just their name. Throws if userId doesn't exist, since a silent no-op there would be
   *  a confusing way to fail. */
  remove(userId: string): Promise<void>;
}

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly db: Queryable) {}

  async create(name: string): Promise<User> {
    const { rows } = await this.db.query<User>(`INSERT INTO users (name) VALUES ($1) RETURNING id, name`, [name]);
    return rows[0];
  }

  async findById(id: string): Promise<User | null> {
    const { rows } = await this.db.query<User>(`SELECT id, name FROM users WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async findByName(name: string): Promise<User | null> {
    const { rows } = await this.db.query<User>(`SELECT id, name FROM users WHERE name = $1`, [name]);
    return rows[0] ?? null;
  }

  async listAll(): Promise<User[]> {
    const { rows } = await this.db.query<User>(`SELECT id, name FROM users ORDER BY name`);
    return rows;
  }

  async remove(userId: string): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(`DELETE FROM users WHERE id = $1 RETURNING id`, [userId]);
    if (rows.length === 0) {
      throw new Error(`No user with id "${userId}" — cannot remove a user that doesn't exist.`);
    }
  }
}
