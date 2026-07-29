import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresUpstreamServerRepository } from "../../src/db/UpstreamServerRepository.js";
import { withTransaction } from "./setupDatabase.js";

test(
  "finds a server with no args (e.g. the filesystem server)",
  withTransaction(async ({ db }) => {
    await db.query(`INSERT INTO upstream_servers (name, command) VALUES ($1, $2)`, ["filesystem", "npx"]);

    const server = await new PostgresUpstreamServerRepository(db).findByName("filesystem");

    assert.ok(server);
    assert.equal(server.command, "npx");
    assert.deepEqual(server.args, []);
  }),
);

test(
  "finds a server's args in the order they were stored",
  withTransaction(async ({ db }) => {
    await db.query(`INSERT INTO upstream_servers (name, command, args) VALUES ($1, $2, $3)`, [
      "filesystem-scoped",
      "npx",
      JSON.stringify(["-y", "@modelcontextprotocol/server-filesystem", "/tmp/sandbox"]),
    ]);

    const server = await new PostgresUpstreamServerRepository(db).findByName("filesystem-scoped");

    assert.deepEqual(server?.args, ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/sandbox"]);
  }),
);

test(
  "returns null for an unregistered server name",
  withTransaction(async ({ db }) => {
    const server = await new PostgresUpstreamServerRepository(db).findByName("does-not-exist");

    assert.equal(server, null);
  }),
);

test(
  "findManyByIds resolves several servers in one call, in no particular guaranteed order",
  withTransaction(async ({ db }) => {
    const {
      rows: [a],
    } = await db.query<{ id: string }>(`INSERT INTO upstream_servers (name, command) VALUES ('a', 'cmd-a') RETURNING id`);
    const {
      rows: [b],
    } = await db.query<{ id: string }>(`INSERT INTO upstream_servers (name, command) VALUES ('b', 'cmd-b') RETURNING id`);
    await db.query(`INSERT INTO upstream_servers (name, command) VALUES ('c', 'cmd-c')`); // deliberately not requested

    const servers = await new PostgresUpstreamServerRepository(db).findManyByIds([a.id, b.id]);

    assert.deepEqual(new Set(servers.map((s) => s.name)), new Set(["a", "b"]));
  }),
);

test(
  "findManyByIds returns an empty array for an empty input, without querying",
  withTransaction(async ({ db }) => {
    const servers = await new PostgresUpstreamServerRepository(db).findManyByIds([]);

    assert.deepEqual(servers, []);
  }),
);

test(
  "create() registers a server with the standard {command, args} shape",
  withTransaction(async ({ db }) => {
    const created = await new PostgresUpstreamServerRepository(db).create({
      name: "sonarqube",
      command: "docker",
      args: ["run", "--init", "-i", "--rm", "mcp/sonarqube-mb"],
    });

    assert.equal(created.name, "sonarqube");
    assert.equal(created.command, "docker");
    assert.deepEqual(created.args, ["run", "--init", "-i", "--rm", "mcp/sonarqube-mb"]);
  }),
);

test(
  "create() defaults to no args when none are given",
  withTransaction(async ({ db }) => {
    const created = await new PostgresUpstreamServerRepository(db).create({ name: "memory", command: "npx", args: [] });

    assert.deepEqual(created.args, []);
  }),
);
