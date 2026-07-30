/** "all" for a blanket grant (tool_name IS NULL); otherwise the exact set of tool names
 *  granted. Lets a caller that needs to check many tool names at once (see
 *  ToolDiscoveryRouter.findTool) do it against one query's result instead of issuing one
 *  query per tool. */
export type AllowedTools = "all" | ReadonlySet<string>;

/**
 * Permissions are granted to roles, not individual users or identities (see
 * migrations/007_roles.sql) — a user's effective access is the union of every role they
 * hold. Every method here still takes a `userId` (resolved from whichever identity
 * authenticated the current request, see Identity.userId in domain/types.ts) and resolves it
 * through that user's roles internally — callers never need to know roles exist at all,
 * this repository is the one place that resolution happens.
 */
export interface PermissionRepository {
  /** True if userId may call toolName on serverId, via any role they hold — either an
   *  exact-match grant or a blanket grant (tool_name IS NULL) for every tool on that
   *  server. Optimized for checking a single, known tool name (the actual call path) —
   *  see findAllowedToolNames for the "check many tool names at once" access pattern
   *  (discovery). */
  isCallAllowed(userId: string, serverId: string, toolName: string): Promise<boolean>;

  /** Every upstream_servers.id this user's roles hold at least one permission row for —
   *  the set of servers a multi-server gateway should connect to and discover tools
   *  across on this user's behalf. Having ANY grant on a server (even a single narrow
   *  tool_name) is enough to make that server discoverable; the actual call is still
   *  gated per-tool by isCallAllowed/findAllowedToolNames. */
  findAccessibleServerIds(userId: string): Promise<string[]>;

  /** Every tool this user's roles grant on serverId, in one query — the batch counterpart
   *  to isCallAllowed. Use this instead of calling isCallAllowed once per candidate tool
   *  when checking a whole tool list at once (e.g. filtering find_tool's results). */
  findAllowedToolNames(userId: string, serverId: string): Promise<AllowedTools>;

  /** Grants roleId access to serverId — toolName null means every tool on that server
   *  (a blanket grant), matching how permissions.tool_name IS NULL is interpreted
   *  everywhere else. Idempotent — granting the same (role, server, tool) twice is a
   *  no-op, not an error. Deliberately NOT implemented as a plain `ON CONFLICT DO
   *  NOTHING` against permissions' UNIQUE(role_id, server_id, tool_name) constraint —
   *  standard SQL treats every NULL as distinct from every other NULL for uniqueness
   *  purposes, so that alone would let repeated blanket grants (tool_name IS NULL)
   *  silently duplicate instead of no-op. */
  grant(roleId: string, serverId: string, toolName: string | null): Promise<void>;

  /** Idempotent — revoking a grant that doesn't exist is a harmless no-op. */
  revoke(roleId: string, serverId: string, toolName: string | null): Promise<void>;
}
