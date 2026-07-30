import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresToolCatalogRepository } from "../../src/adapters/postgres/ToolCatalogRepository.js";
import { withTransaction } from "./setupDatabase.js";

async function seedServer(db: import("../../src/ports/Queryable.js").Queryable, name: string): Promise<string> {
  const {
    rows: [row],
  } = await db.query<{ id: string }>(`INSERT INTO upstream_servers (name, command) VALUES ($1, 'npx') RETURNING id`, [name]);
  return row.id;
}

test(
  "findByServer returns an empty array for a server never cataloged",
  withTransaction(async ({ db }) => {
    const serverId = await seedServer(db, "never-cataloged");

    const entries = await new PostgresToolCatalogRepository(db).findByServer(serverId);

    assert.deepEqual(entries, []);
  }),
);

test(
  "replaceForServer then findByServer round-trips name, description, and embedding exactly",
  withTransaction(async ({ db }) => {
    const serverId = await seedServer(db, "sonarqube");
    const repo = new PostgresToolCatalogRepository(db);

    await repo.replaceForServer(serverId, [
      { toolName: "search_issues", description: "Search SonarQube issues", embedding: [0.1, 0.2, 0.3] },
      { toolName: "get_metrics", description: "Get code quality metrics", embedding: [-0.5, 0, 0.25] },
    ]);
    const entries = await repo.findByServer(serverId);

    assert.equal(entries.length, 2);
    const searchIssues = entries.find((e) => e.toolName === "search_issues");
    assert.equal(searchIssues?.description, "Search SonarQube issues");
    assert.deepEqual(searchIssues?.embedding, [0.1, 0.2, 0.3]);
    assert.ok(searchIssues?.refreshedAt instanceof Date);
  }),
);

test(
  "replaceForServer entirely replaces the previous set — a removed tool disappears, not just an added one appears",
  withTransaction(async ({ db }) => {
    const serverId = await seedServer(db, "sonarqube");
    const repo = new PostgresToolCatalogRepository(db);

    await repo.replaceForServer(serverId, [
      { toolName: "old_tool", description: "will be removed", embedding: [1] },
      { toolName: "kept_tool", description: "stays, but re-embedded", embedding: [1] },
    ]);
    await repo.replaceForServer(serverId, [{ toolName: "kept_tool", description: "stays, but re-embedded", embedding: [2] }]);

    const entries = await repo.findByServer(serverId);

    assert.deepEqual(
      entries.map((e) => e.toolName),
      ["kept_tool"],
    );
  }),
);

test(
  "replaceForServer with zero entries clears a server's catalog without erroring",
  withTransaction(async ({ db }) => {
    const serverId = await seedServer(db, "sonarqube");
    const repo = new PostgresToolCatalogRepository(db);
    await repo.replaceForServer(serverId, [{ toolName: "will_be_cleared", description: "", embedding: [1] }]);

    await repo.replaceForServer(serverId, []);

    assert.deepEqual(await repo.findByServer(serverId), []);
  }),
);

test(
  "two different servers' catalogs never leak into each other",
  withTransaction(async ({ db }) => {
    const serverA = await seedServer(db, "server-a");
    const serverB = await seedServer(db, "server-b");
    const repo = new PostgresToolCatalogRepository(db);

    await repo.replaceForServer(serverA, [{ toolName: "tool_a", description: "", embedding: [1] }]);
    await repo.replaceForServer(serverB, [{ toolName: "tool_b", description: "", embedding: [1] }]);

    assert.deepEqual(
      (await repo.findByServer(serverA)).map((e) => e.toolName),
      ["tool_a"],
    );
    assert.deepEqual(
      (await repo.findByServer(serverB)).map((e) => e.toolName),
      ["tool_b"],
    );
  }),
);

test(
  "deleting the upstream server cascades to its catalog entries",
  withTransaction(async ({ db }) => {
    const serverId = await seedServer(db, "temporary-server");
    const repo = new PostgresToolCatalogRepository(db);
    await repo.replaceForServer(serverId, [{ toolName: "some_tool", description: "", embedding: [1] }]);

    await db.query(`DELETE FROM upstream_servers WHERE id = $1`, [serverId]);

    const { rows } = await db.query(`SELECT 1 FROM tool_catalog WHERE server_id = $1`, [serverId]);
    assert.equal(rows.length, 0);
  }),
);
