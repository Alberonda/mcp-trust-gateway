/** One cached (server, tool) entry — see migrations/009_tool_catalog.sql. */
export interface ToolCatalogEntry {
  readonly toolName: string;
  readonly description: string;
  readonly embedding: readonly number[];
  readonly refreshedAt: Date;
}

export interface NewToolCatalogEntry {
  readonly toolName: string;
  readonly description: string;
  readonly embedding: readonly number[];
}

/**
 * The cached record of what tools a server offers, so find_tool can search across every
 * accessible server without connecting to any of them — see
 * domain/ToolDiscoveryRouter.ts and DESIGN.md's backlog entry on this. Populated lazily
 * (the first successful real connection to a server builds it) and refreshed
 * opportunistically (see TOOL_CATALOG_TTL_MS) rather than on any dedicated schedule.
 */
export interface ToolCatalogRepository {
  /** Empty array means "never cataloged yet" — every entry sharing one server always
   *  shares one `refreshedAt` (see replaceForServer), so checking staleness only needs
   *  to look at entries[0]. */
  findByServer(serverId: string): Promise<ToolCatalogEntry[]>;

  /** Atomically replaces every cached entry for this server with exactly `entries` —
   *  not an upsert-per-tool, since a tool renamed or removed upstream must disappear
   *  from the cache too, not linger as a stale row forever. */
  replaceForServer(serverId: string, entries: readonly NewToolCatalogEntry[]): Promise<void>;
}
