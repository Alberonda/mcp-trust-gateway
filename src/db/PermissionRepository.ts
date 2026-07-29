import type { Queryable } from "./Queryable.js";

export interface PermissionRepository {
  /** True if identityId may call toolName on serverId — either via an exact-match grant
   *  or a blanket grant (tool_name IS NULL) for every tool on that server. */
  isCallAllowed(identityId: string, serverId: string, toolName: string): Promise<boolean>;

  /** Every upstream_servers.id this identity holds at least one permission row for —
   *  the set of servers a multi-server gateway should connect to and discover tools
   *  across on this identity's behalf. Having ANY grant on a server (even a single
   *  narrow tool_name) is enough to make that server discoverable; ToolCallHandler's
   *  existing per-tool check still gates the actual call. */
  findAccessibleServerIds(identityId: string): Promise<string[]>;
}

export class PostgresPermissionRepository implements PermissionRepository {
  constructor(private readonly db: Queryable) {}

  async isCallAllowed(identityId: string, serverId: string, toolName: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM permissions
       WHERE identity_id = $1 AND server_id = $2 AND (tool_name = $3 OR tool_name IS NULL)
       LIMIT 1`,
      [identityId, serverId, toolName],
    );
    return rows.length > 0;
  }

  async findAccessibleServerIds(identityId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ serverId: string }>(
      `SELECT DISTINCT server_id AS "serverId" FROM permissions WHERE identity_id = $1`,
      [identityId],
    );
    return rows.map((row) => row.serverId);
  }
}
