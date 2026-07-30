import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresPermissionRepository } from "../../src/adapters/postgres/PermissionRepository.js";
import { grantPermission, seedRole, seedServer, seedUserAndIdentity } from "./testFixtures.js";
import { withTransaction } from "./setupDatabase.js";

test(
  "an exact-match grant allows only that specific tool",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "agent");
    const serverId = await seedServer(db, "server");
    await grantPermission(db, userId, serverId, "read_file");

    const repo = new PostgresPermissionRepository(db);

    assert.equal(await repo.isCallAllowed(userId, serverId, "read_file"), true);
    assert.equal(await repo.isCallAllowed(userId, serverId, "write_file"), false);
  }),
);

test(
  "a blanket grant (tool_name IS NULL) allows every tool on that server",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "agent");
    const serverId = await seedServer(db, "server");
    await grantPermission(db, userId, serverId, null);

    const repo = new PostgresPermissionRepository(db);

    assert.equal(await repo.isCallAllowed(userId, serverId, "read_file"), true);
    assert.equal(await repo.isCallAllowed(userId, serverId, "delete_everything"), true);
  }),
);

test(
  "no permission row at all means denied",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "agent");
    const serverId = await seedServer(db, "server");

    const allowed = await new PostgresPermissionRepository(db).isCallAllowed(userId, serverId, "read_file");

    assert.equal(allowed, false);
  }),
);

test(
  "a grant for a different server does not leak permission to this one",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "agent");
    const serverId = await seedServer(db, "server");
    const otherServerId = await seedServer(db, "other-server");
    await grantPermission(db, userId, otherServerId, null);

    const allowed = await new PostgresPermissionRepository(db).isCallAllowed(userId, serverId, "read_file");

    assert.equal(allowed, false);
  }),
);

test(
  "two identities belonging to the same user share that user's grants",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "laptop-key");
    // A second identity for the SAME user (e.g. a CI key) — insert directly since
    // seedUserAndIdentity always creates a fresh user.
    await db.query(`INSERT INTO identities (user_id, name, api_key_hash) VALUES ($1, 'ci-key', 'hash-ci')`, [userId]);
    const serverId = await seedServer(db, "server");
    await grantPermission(db, userId, serverId, "read_file");

    // Both identities resolve to the same userId, so a single permission check against
    // that userId governs both — this is the entire point of the Phase 3 schema change.
    const allowed = await new PostgresPermissionRepository(db).isCallAllowed(userId, serverId, "read_file");

    assert.equal(allowed, true);
  }),
);

test(
  "a user with two roles gets the union of both roles' grants",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "multi-role-agent");
    const serverA = await seedServer(db, "a");
    const serverB = await seedServer(db, "b");
    // grantPermission creates a fresh role per call, so this user ends up holding two
    // distinct roles, each granting access to a different server.
    await grantPermission(db, userId, serverA, null);
    await grantPermission(db, userId, serverB, null);

    const repo = new PostgresPermissionRepository(db);

    assert.equal(await repo.isCallAllowed(userId, serverA, "read_file"), true);
    assert.equal(await repo.isCallAllowed(userId, serverB, "read_file"), true);
  }),
);

test(
  "findAccessibleServerIds returns every distinct server this user has any grant on",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "agent");
    const serverA = await seedServer(db, "a");
    const serverB = await seedServer(db, "b");
    await seedServer(db, "c"); // deliberately not granted — must not appear below
    await grantPermission(db, userId, serverA, "read_file");
    await grantPermission(db, userId, serverB, null);

    const accessible = await new PostgresPermissionRepository(db).findAccessibleServerIds(userId);

    assert.deepEqual(new Set(accessible), new Set([serverA, serverB]));
  }),
);

test(
  "findAccessibleServerIds returns an empty list for a user with no grants at all",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "lonely");

    const accessible = await new PostgresPermissionRepository(db).findAccessibleServerIds(userId);

    assert.deepEqual(accessible, []);
  }),
);

test(
  "findAllowedToolNames returns 'all' when there's a blanket grant, even alongside specific ones",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "agent");
    const serverId = await seedServer(db, "server");
    await grantPermission(db, userId, serverId, "read_file");
    await grantPermission(db, userId, serverId, null);

    const allowed = await new PostgresPermissionRepository(db).findAllowedToolNames(userId, serverId);

    assert.equal(allowed, "all");
  }),
);

test(
  "findAllowedToolNames returns the exact set of granted tool names when there's no blanket grant",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "agent");
    const serverId = await seedServer(db, "server");
    await grantPermission(db, userId, serverId, "read_file");
    await grantPermission(db, userId, serverId, "list_directory");

    const allowed = await new PostgresPermissionRepository(db).findAllowedToolNames(userId, serverId);

    assert.notEqual(allowed, "all");
    assert.deepEqual(allowed, new Set(["read_file", "list_directory"]));
  }),
);

test(
  "findAllowedToolNames returns an empty set for a server with no grants",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "agent");
    const serverId = await seedServer(db, "server");

    const allowed = await new PostgresPermissionRepository(db).findAllowedToolNames(userId, serverId);

    assert.deepEqual(allowed, new Set());
  }),
);

test(
  "grant() then isCallAllowed() reflects a blanket grant immediately",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "agent");
    const roleId = await seedRole(db);
    await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [userId, roleId]);
    const serverId = await seedServer(db, "server");
    const repo = new PostgresPermissionRepository(db);

    await repo.grant(roleId, serverId, null);

    assert.equal(await repo.isCallAllowed(userId, serverId, "anything"), true);
  }),
);

test(
  "grant() called twice with the same (role, server, null) does not create a duplicate row",
  withTransaction(async ({ db }) => {
    const roleId = await seedRole(db);
    const serverId = await seedServer(db, "server");
    const repo = new PostgresPermissionRepository(db);

    await repo.grant(roleId, serverId, null);
    await repo.grant(roleId, serverId, null);

    const { rows } = await db.query(`SELECT * FROM permissions WHERE role_id = $1 AND server_id = $2`, [roleId, serverId]);
    assert.equal(rows.length, 1, "a second identical blanket grant must be a no-op, not a duplicate row (NULL is not distinct from NULL here)");
  }),
);

test(
  "grant() with a specific toolName and grant() with null (blanket) for the same role/server coexist as separate rows",
  withTransaction(async ({ db }) => {
    const roleId = await seedRole(db);
    const serverId = await seedServer(db, "server");
    const repo = new PostgresPermissionRepository(db);

    await repo.grant(roleId, serverId, "read_file");
    await repo.grant(roleId, serverId, null);

    const { rows } = await db.query(`SELECT tool_name FROM permissions WHERE role_id = $1 AND server_id = $2`, [roleId, serverId]);
    assert.equal(rows.length, 2);
  }),
);

test(
  "revoke() removes exactly the grant it's asked to, leaving others on the same role/server intact",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "agent");
    const roleId = await seedRole(db);
    await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [userId, roleId]);
    const serverId = await seedServer(db, "server");
    const repo = new PostgresPermissionRepository(db);
    await repo.grant(roleId, serverId, "read_file");
    await repo.grant(roleId, serverId, "write_file");

    await repo.revoke(roleId, serverId, "read_file");

    assert.equal(await repo.isCallAllowed(userId, serverId, "read_file"), false);
    assert.equal(await repo.isCallAllowed(userId, serverId, "write_file"), true);
  }),
);

test(
  "revoke() of a grant that was never made is a harmless no-op",
  withTransaction(async ({ db }) => {
    const roleId = await seedRole(db);
    const serverId = await seedServer(db, "server");

    await new PostgresPermissionRepository(db).revoke(roleId, serverId, "never-granted");
  }),
);
