import type { NewToolCatalogEntry, ToolCatalogEntry, ToolCatalogRepository } from "../../ports/ToolCatalogRepository.js";
import type { Queryable } from "../../ports/Queryable.js";

interface ToolCatalogRow {
  toolName: string;
  description: string;
  embedding: number[];
  refreshedAt: Date;
}

export class PostgresToolCatalogRepository implements ToolCatalogRepository {
  constructor(private readonly db: Queryable) {}

  async findByServer(serverId: string): Promise<ToolCatalogEntry[]> {
    const { rows } = await this.db.query<ToolCatalogRow>(
      `SELECT tool_name AS "toolName", description, embedding, refreshed_at AS "refreshedAt"
       FROM tool_catalog WHERE server_id = $1`,
      [serverId],
    );
    return rows.map((row) => ({ toolName: row.toolName, description: row.description, embedding: row.embedding, refreshedAt: row.refreshedAt }));
  }

  /** Runs the delete+insert in one transaction-like round trip isn't possible through
   *  the plain Queryable interface (no transaction control there — see Queryable.ts),
   *  but a stale-then-fresh window between the DELETE and INSERT below only ever makes
   *  find_tool briefly under-report one server's tools, never over-report or leak
   *  another server's — an acceptable, self-correcting gap for a cache, not a
   *  correctness problem the way it would be for permissions or credentials. */
  async replaceForServer(serverId: string, entries: readonly NewToolCatalogEntry[]): Promise<void> {
    await this.db.query(`DELETE FROM tool_catalog WHERE server_id = $1`, [serverId]);
    if (entries.length === 0) return;

    const values: string[] = [];
    const params: unknown[] = [];
    entries.forEach((entry, index) => {
      const base = index * 4;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      params.push(serverId, entry.toolName, entry.description, entry.embedding);
    });
    await this.db.query(`INSERT INTO tool_catalog (server_id, tool_name, description, embedding) VALUES ${values.join(", ")}`, params);
  }
}
