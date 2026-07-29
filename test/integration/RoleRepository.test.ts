import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresRoleRepository } from "../../src/db/RoleRepository.js";
import { withTransaction } from "./setupDatabase.js";
import { seedUserAndIdentity } from "./testFixtures.js";

test(
  "create() then findByName() round-trips name and isAdmin",
  withTransaction(async ({ db }) => {
    const repo = new PostgresRoleRepository(db);
    await repo.create("developer", false);

    const found = await repo.findByName("developer");

    assert.ok(found);
    assert.equal(found.name, "developer");
    assert.equal(found.isAdmin, false);
  }),
);

test(
  "findByName returns null for a role that doesn't exist",
  withTransaction(async ({ db }) => {
    const found = await new PostgresRoleRepository(db).findByName("does-not-exist");

    assert.equal(found, null);
  }),
);

test(
  "assignToUser then findRolesForUser resolves every role a user holds",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "alice");
    const repo = new PostgresRoleRepository(db);
    const developer = await repo.create("developer", false);
    const marketing = await repo.create("marketing", false);
    await repo.create("hr", false); // deliberately not assigned — must not appear below

    await repo.assignToUser(userId, developer.id);
    await repo.assignToUser(userId, marketing.id);

    const roles = await repo.findRolesForUser(userId);

    assert.deepEqual(new Set(roles.map((r) => r.name)), new Set(["developer", "marketing"]));
  }),
);

test(
  "assignToUser is idempotent — assigning the same role twice doesn't duplicate it",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "alice");
    const repo = new PostgresRoleRepository(db);
    const role = await repo.create("developer", false);

    await repo.assignToUser(userId, role.id);
    await repo.assignToUser(userId, role.id);

    const roles = await repo.findRolesForUser(userId);
    assert.equal(roles.length, 1);
  }),
);

test(
  "unassignFromUser removes the role, and is a harmless no-op if the user never held it",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "alice");
    const repo = new PostgresRoleRepository(db);
    const role = await repo.create("developer", false);
    await repo.assignToUser(userId, role.id);

    await repo.unassignFromUser(userId, role.id);
    await repo.unassignFromUser(userId, role.id); // second call must not throw

    assert.deepEqual(await repo.findRolesForUser(userId), []);
  }),
);

test(
  "isUserAdmin is true only if the user holds a role with isAdmin = true",
  withTransaction(async ({ db }) => {
    const { userId: adminUserId } = await seedUserAndIdentity(db, "admin-alice");
    const { userId: regularUserId } = await seedUserAndIdentity(db, "regular-bob");
    const repo = new PostgresRoleRepository(db);
    const adminRole = await repo.create("admin", true);
    const developerRole = await repo.create("developer", false);
    await repo.assignToUser(adminUserId, adminRole.id);
    await repo.assignToUser(regularUserId, developerRole.id);

    assert.equal(await repo.isUserAdmin(adminUserId), true);
    assert.equal(await repo.isUserAdmin(regularUserId), false);
  }),
);

test(
  "listAll returns every role, ordered by name",
  withTransaction(async ({ db }) => {
    const repo = new PostgresRoleRepository(db);
    await repo.create("marketing", false);
    await repo.create("developer", false);

    const roles = await repo.listAll();

    assert.deepEqual(roles.map((r) => r.name), ["developer", "marketing"]);
  }),
);

test(
  "remove() deletes the role and every permission/assignment referencing it",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "alice");
    const repo = new PostgresRoleRepository(db);
    const role = await repo.create("developer", false);
    await repo.assignToUser(userId, role.id);

    await repo.remove(role.id);

    assert.equal(await repo.findByName("developer"), null);
    assert.deepEqual(await repo.findRolesForUser(userId), []);
  }),
);

test(
  "remove() throws for a role id that doesn't exist, instead of silently doing nothing",
  withTransaction(async ({ db }) => {
    const repo = new PostgresRoleRepository(db);

    await assert.rejects(() => repo.remove("00000000-0000-0000-0000-000000000000"));
  }),
);
