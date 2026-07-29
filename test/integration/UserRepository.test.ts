import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresUserRepository } from "../../src/db/UserRepository.js";
import { withTransaction } from "./setupDatabase.js";

test(
  "create() then findByName() round-trips",
  withTransaction(async ({ db }) => {
    const repo = new PostgresUserRepository(db);
    await repo.create("alice");

    const found = await repo.findByName("alice");

    assert.ok(found);
    assert.equal(found.name, "alice");
  }),
);

test(
  "findByName returns null for a user that doesn't exist",
  withTransaction(async ({ db }) => {
    const found = await new PostgresUserRepository(db).findByName("does-not-exist");

    assert.equal(found, null);
  }),
);

test(
  "listAll returns every user, ordered by name",
  withTransaction(async ({ db }) => {
    const repo = new PostgresUserRepository(db);
    await repo.create("bob");
    await repo.create("alice");

    const users = await repo.listAll();

    assert.deepEqual(users.map((u) => u.name), ["alice", "bob"]);
  }),
);

test(
  "remove() deletes the user, and throws for a user id that doesn't exist",
  withTransaction(async ({ db }) => {
    const repo = new PostgresUserRepository(db);
    const user = await repo.create("alice");

    await repo.remove(user.id);

    assert.equal(await repo.findById(user.id), null);
    await assert.rejects(() => repo.remove(user.id));
  }),
);
