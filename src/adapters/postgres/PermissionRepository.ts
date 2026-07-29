import type { AllowedTools, PermissionRepository } from "../../ports/PermissionRepository.js";
import type { Queryable } from "../../ports/Queryable.js";

export class PostgresPermissionRepository implements PermissionRepository {
  constructor(private readonly db: Queryable) {}

  async isCallAllowed(userId: string, serverId: string, toolName: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM permissions p
       JOIN user_roles ur ON ur.role_id = p.role_id
       WHERE ur.user_id = $1 AND p.server_id = $2 AND (p.tool_name = $3 OR p.tool_name IS NULL)
       LIMIT 1`,
      [userId, serverId, toolName],
    );
    return rows.length > 0;
  }

  async findAccessibleServerIds(userId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ serverId: string }>(
      `SELECT DISTINCT p.server_id AS "serverId" FROM permissions p
       JOIN user_roles ur ON ur.role_id = p.role_id
       WHERE ur.user_id = $1`,
      [userId],
    );
    return rows.map((row) => row.serverId);
  }

  async findAllowedToolNames(userId: string, serverId: string): Promise<AllowedTools> {
    const { rows } = await this.db.query<{ toolName: string | null }>(
      `SELECT p.tool_name AS "toolName" FROM permissions p
       JOIN user_roles ur ON ur.role_id = p.role_id
       WHERE ur.user_id = $1 AND p.server_id = $2`,
      [userId, serverId],
    );
    if (rows.some((row) => row.toolName === null)) return "all";
    return new Set(rows.map((row) => row.toolName!));
  }
}
