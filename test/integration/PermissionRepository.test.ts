import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresPermissionRepository } from "../../src/db/PermissionRepository.js";
import type { Queryable } from "../../src/db/Queryable.js";
import { withTransaction } from "./setupDatabase.js";

async function seedIdentityAndServer(db: Queryable): Promise<{ identityId: string; serverId: string }> {
  const {
    rows: [identity],
  } = await db.query<{ id: string }>(`INSERT INTO identities (name, api_key_hash) VALUES ('agent', 'h') RETURNING id`);
  const {
    rows: [server],
  } = await db.query<{ id: string }>(
    `INSERT INTO upstream_servers (name, command) VALUES ('server', 'cmd') RETURNING id`,
  );
  return { identityId: identity.id, serverId: server.id };
}

test(
  "an exact-match grant allows only that specific tool",
  withTransaction(async ({ db }) => {
    const { identityId, serverId } = await seedIdentityAndServer(db);
    await db.query(`INSERT INTO permissions (identity_id, server_id, tool_name) VALUES ($1, $2, 'read_file')`, [
      identityId,
      serverId,
    ]);

    const repo = new PostgresPermissionRepository(db);

    assert.equal(await repo.isCallAllowed(identityId, serverId, "read_file"), true);
    assert.equal(await repo.isCallAllowed(identityId, serverId, "write_file"), false);
  }),
);

test(
  "a blanket grant (tool_name IS NULL) allows every tool on that server",
  withTransaction(async ({ db }) => {
    const { identityId, serverId } = await seedIdentityAndServer(db);
    await db.query(`INSERT INTO permissions (identity_id, server_id, tool_name) VALUES ($1, $2, NULL)`, [
      identityId,
      serverId,
    ]);

    const repo = new PostgresPermissionRepository(db);

    assert.equal(await repo.isCallAllowed(identityId, serverId, "read_file"), true);
    assert.equal(await repo.isCallAllowed(identityId, serverId, "delete_everything"), true);
  }),
);

test(
  "no permission row at all means denied",
  withTransaction(async ({ db }) => {
    const { identityId, serverId } = await seedIdentityAndServer(db);

    const allowed = await new PostgresPermissionRepository(db).isCallAllowed(identityId, serverId, "read_file");

    assert.equal(allowed, false);
  }),
);

test(
  "a grant for a different server does not leak permission to this one",
  withTransaction(async ({ db }) => {
    const { identityId, serverId } = await seedIdentityAndServer(db);
    const {
      rows: [otherServer],
    } = await db.query<{ id: string }>(
      `INSERT INTO upstream_servers (name, command) VALUES ('other-server', 'cmd') RETURNING id`,
    );
    await db.query(`INSERT INTO permissions (identity_id, server_id, tool_name) VALUES ($1, $2, NULL)`, [
      identityId,
      otherServer.id,
    ]);

    const allowed = await new PostgresPermissionRepository(db).isCallAllowed(identityId, serverId, "read_file");

    assert.equal(allowed, false);
  }),
);

test(
  "findAccessibleServerIds returns every distinct server this identity has any grant on",
  withTransaction(async ({ db }) => {
    const { identityId, serverId: serverA } = await seedIdentityAndServer(db);
    const {
      rows: [serverB],
    } = await db.query<{ id: string }>(`INSERT INTO upstream_servers (name, command) VALUES ('b', 'cmd') RETURNING id`);
    const {
      rows: [serverC],
    } = await db.query<{ id: string }>(`INSERT INTO upstream_servers (name, command) VALUES ('c', 'cmd') RETURNING id`);
    await db.query(`INSERT INTO permissions (identity_id, server_id, tool_name) VALUES ($1, $2, 'read_file')`, [
      identityId,
      serverA,
    ]);
    await db.query(`INSERT INTO permissions (identity_id, server_id, tool_name) VALUES ($1, $2, NULL)`, [
      identityId,
      serverB.id,
    ]);
    // Deliberately no permission row for serverC — it must not appear below.
    void serverC;

    const accessible = await new PostgresPermissionRepository(db).findAccessibleServerIds(identityId);

    assert.deepEqual(new Set(accessible), new Set([serverA, serverB.id]));
  }),
);

test(
  "findAccessibleServerIds returns an empty list for an identity with no grants at all",
  withTransaction(async ({ db }) => {
    const {
      rows: [identity],
    } = await db.query<{ id: string }>(`INSERT INTO identities (name, api_key_hash) VALUES ('lonely', 'h') RETURNING id`);

    const accessible = await new PostgresPermissionRepository(db).findAccessibleServerIds(identity.id);

    assert.deepEqual(accessible, []);
  }),
);

test(
  "findAllowedToolNames returns 'all' when there's a blanket grant, even alongside specific ones",
  withTransaction(async ({ db }) => {
    const { identityId, serverId } = await seedIdentityAndServer(db);
    await db.query(`INSERT INTO permissions (identity_id, server_id, tool_name) VALUES ($1, $2, 'read_file')`, [
      identityId,
      serverId,
    ]);
    await db.query(`INSERT INTO permissions (identity_id, server_id, tool_name) VALUES ($1, $2, NULL)`, [
      identityId,
      serverId,
    ]);

    const allowed = await new PostgresPermissionRepository(db).findAllowedToolNames(identityId, serverId);

    assert.equal(allowed, "all");
  }),
);

test(
  "findAllowedToolNames returns the exact set of granted tool names when there's no blanket grant",
  withTransaction(async ({ db }) => {
    const { identityId, serverId } = await seedIdentityAndServer(db);
    await db.query(`INSERT INTO permissions (identity_id, server_id, tool_name) VALUES ($1, $2, 'read_file')`, [
      identityId,
      serverId,
    ]);
    await db.query(`INSERT INTO permissions (identity_id, server_id, tool_name) VALUES ($1, $2, 'list_directory')`, [
      identityId,
      serverId,
    ]);

    const allowed = await new PostgresPermissionRepository(db).findAllowedToolNames(identityId, serverId);

    assert.notEqual(allowed, "all");
    assert.deepEqual(allowed, new Set(["read_file", "list_directory"]));
  }),
);

test(
  "findAllowedToolNames returns an empty set for a server with no grants",
  withTransaction(async ({ db }) => {
    const { identityId, serverId } = await seedIdentityAndServer(db);

    const allowed = await new PostgresPermissionRepository(db).findAllowedToolNames(identityId, serverId);

    assert.deepEqual(allowed, new Set());
  }),
);
