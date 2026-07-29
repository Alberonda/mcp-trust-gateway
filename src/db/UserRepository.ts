import type { Queryable } from "./Queryable.js";
import type { User } from "./types.js";

export interface UserRepository {
  create(name: string): Promise<User>;
  findById(id: string): Promise<User | null>;
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
}
