import type { User } from "../../domain/types.js";
import type { UserRepository } from "../../ports/UserRepository.js";
import type { Queryable } from "../../ports/Queryable.js";

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
