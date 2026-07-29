import type { Role } from "../../domain/types.js";
import type { RoleRepository } from "../../ports/RoleRepository.js";
import type { Queryable } from "../../ports/Queryable.js";

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
