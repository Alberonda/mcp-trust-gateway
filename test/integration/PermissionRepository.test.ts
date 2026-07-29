import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresPermissionRepository } from "../../src/db/PermissionRepository.js";
import { grantPermission, seedServer, seedUserAndIdentity } from "./testFixtures.js";
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
