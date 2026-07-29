import type { Queryable } from "./Queryable.js";
import type { Role } from "./types.js";

/**
 * Roles are what permissions are actually granted to (see migrations/007_roles.sql).
 * Users hold zero or more roles; their effective access is the union of all of them.
 */
export interface RoleRepository {
  create(name: string, isAdmin: boolean): Promise<Role>;
  findByName(name: string): Promise<Role | null>;
  findById(id: string): Promise<Role | null>;
  listAll(): Promise<Role[]>;
  /** Every role this user holds. */
  findRolesForUser(userId: string): Promise<Role[]>;
  /** True if this user holds at least one role with isAdmin = true. */
  isUserAdmin(userId: string): Promise<boolean>;
  /** Idempotent — assigning a role the user already holds is a no-op, not an error. */
  assignToUser(userId: string, roleId: string): Promise<void>;
  /** Idempotent — unassigning a role the user doesn't hold is a harmless no-op. */
  unassignFromUser(userId: string, roleId: string): Promise<void>;
  /** Deletes the role entirely — cascades to user_roles and permissions rows referencing
   *  it (see migrations/007_roles.sql's ON DELETE CASCADE). Throws if roleId doesn't
   *  exist, since a silent no-op there would be a confusing way to fail. */
  remove(roleId: string): Promise<void>;
}

interface RoleRow {
  id: string;
  name: string;
  isAdmin: boolean;
}

const ROLE_COLUMNS = `id, name, is_admin AS "isAdmin"`;

function mapRow(row: RoleRow): Role {
  return { id: row.id, name: row.name, isAdmin: row.isAdmin };
}

export class PostgresRoleRepository implements RoleRepository {
  constructor(private readonly db: Queryable) {}

  async create(name: string, isAdmin: boolean): Promise<Role> {
    const { rows } = await this.db.query<RoleRow>(
      `INSERT INTO roles (name, is_admin) VALUES ($1, $2) RETURNING ${ROLE_COLUMNS}`,
      [name, isAdmin],
    );
    return mapRow(rows[0]);
  }

  async findByName(name: string): Promise<Role | null> {
    const { rows } = await this.db.query<RoleRow>(`SELECT ${ROLE_COLUMNS} FROM roles WHERE name = $1`, [name]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findById(id: string): Promise<Role | null> {
    const { rows } = await this.db.query<RoleRow>(`SELECT ${ROLE_COLUMNS} FROM roles WHERE id = $1`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async listAll(): Promise<Role[]> {
    const { rows } = await this.db.query<RoleRow>(`SELECT ${ROLE_COLUMNS} FROM roles ORDER BY name`);
    return rows.map(mapRow);
  }

  async findRolesForUser(userId: string): Promise<Role[]> {
    const { rows } = await this.db.query<RoleRow>(
      `SELECT r.id, r.name, r.is_admin AS "isAdmin" FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1
       ORDER BY r.name`,
      [userId],
    );
    return rows.map(mapRow);
  }

  async isUserAdmin(userId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM roles r JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1 AND r.is_admin = true LIMIT 1`,
      [userId],
    );
    return rows.length > 0;
  }

  async assignToUser(userId: string, roleId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT (user_id, role_id) DO NOTHING`,
      [userId, roleId],
    );
  }

  async unassignFromUser(userId: string, roleId: string): Promise<void> {
    await this.db.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2`, [userId, roleId]);
  }

  async remove(roleId: string): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(`DELETE FROM roles WHERE id = $1 RETURNING id`, [roleId]);
    if (rows.length === 0) {
      throw new Error(`No role with id "${roleId}" — cannot remove a role that doesn't exist.`);
    }
  }
}
