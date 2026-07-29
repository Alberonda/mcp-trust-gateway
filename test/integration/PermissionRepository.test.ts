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
