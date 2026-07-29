import type { Queryable } from "./Queryable.js";

/** "all" for a blanket grant (tool_name IS NULL); otherwise the exact set of tool names
 *  granted. Lets a caller that needs to check many tool names at once (see
 *  ToolDiscoveryRouter.findTool) do it against one query's result instead of issuing one
 *  query per tool. */
export type AllowedTools = "all" | ReadonlySet<string>;

/**
 * Permissions are granted to users, not individual identities (API keys/sessions) — one
 * user can hold several identities that all share the same grants automatically. Every
 * method here takes a `userId`, resolved from whichever identity authenticated the current
 * request (see Identity.userId in db/types.ts).
 */
export interface PermissionRepository {
  /** True if userId may call toolName on serverId — either via an exact-match grant or a
   *  blanket grant (tool_name IS NULL) for every tool on that server. Optimized for
   *  checking a single, known tool name (the actual call path) — see findAllowedToolNames
   *  for the "check many tool names at once" access pattern (discovery). */
  isCallAllowed(userId: string, serverId: string, toolName: string): Promise<boolean>;

  /** Every upstream_servers.id this user holds at least one permission row for — the set
   *  of servers a multi-server gateway should connect to and discover tools across on this
   *  user's behalf. Having ANY grant on a server (even a single narrow tool_name) is enough
   *  to make that server discoverable; the actual call is still gated per-tool by
   *  isCallAllowed/findAllowedToolNames. */
  findAccessibleServerIds(userId: string): Promise<string[]>;

  /** Every tool this user may call on serverId, in one query — the batch counterpart to
   *  isCallAllowed. Use this instead of calling isCallAllowed once per candidate tool when
   *  checking a whole tool list at once (e.g. filtering find_tool's results). */
  findAllowedToolNames(userId: string, serverId: string): Promise<AllowedTools>;
}

export class PostgresPermissionRepository implements PermissionRepository {
  constructor(private readonly db: Queryable) {}

  async isCallAllowed(userId: string, serverId: string, toolName: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM permissions
       WHERE user_id = $1 AND server_id = $2 AND (tool_name = $3 OR tool_name IS NULL)
       LIMIT 1`,
      [userId, serverId, toolName],
    );
    return rows.length > 0;
  }

  async findAccessibleServerIds(userId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ serverId: string }>(
      `SELECT DISTINCT server_id AS "serverId" FROM permissions WHERE user_id = $1`,
      [userId],
    );
    return rows.map((row) => row.serverId);
  }

  async findAllowedToolNames(userId: string, serverId: string): Promise<AllowedTools> {
    const { rows } = await this.db.query<{ toolName: string | null }>(
      `SELECT tool_name AS "toolName" FROM permissions WHERE user_id = $1 AND server_id = $2`,
      [userId, serverId],
    );
    if (rows.some((row) => row.toolName === null)) return "all";
    return new Set(rows.map((row) => row.toolName!));
  }
}
