import type pg from "pg";

export interface PermissionRepository {
  /** True if identityId may call toolName on serverId — either via an exact-match grant
   *  or a blanket grant (tool_name IS NULL) for every tool on that server. */
  isCallAllowed(identityId: string, serverId: string, toolName: string): Promise<boolean>;
}

export class PostgresPermissionRepository implements PermissionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async isCallAllowed(identityId: string, serverId: string, toolName: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM permissions
       WHERE identity_id = $1 AND server_id = $2 AND (tool_name = $3 OR tool_name IS NULL)
       LIMIT 1`,
      [identityId, serverId, toolName],
    );
    return rows.length > 0;
  }
}
