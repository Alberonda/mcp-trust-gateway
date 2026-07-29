import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresSessionRepository } from "../../src/db/SessionRepository.js";
import { seedUserAndIdentity } from "./testFixtures.js";
import { withTransaction } from "./setupDatabase.js";

test(
  "create() then findByToken() resolves the same user and identity that logged in",
  withTransaction(async ({ db }) => {
    const { userId, identityId } = await seedUserAndIdentity(db, "agent");
    const repo = new PostgresSessionRepository(db);

    const { token } = await repo.create(userId, identityId, 60);
    const session = await repo.findByToken(token);

    assert.deepEqual(session, { userId, identityId });
  }),
);

test(
  "findByToken returns null for a token that was never issued",
  withTransaction(async ({ db }) => {
    const session = await new PostgresSessionRepository(db).findByToken("mtgs_never-issued");

    assert.equal(session, null);
  }),
);

test(
  "findByToken returns null for an expired session, even though the row still exists",
  withTransaction(async ({ db }) => {
    const { userId, identityId } = await seedUserAndIdentity(db, "agent");
    const repo = new PostgresSessionRepository(db);

    // ttlMinutes of -1 issues a session that's already expired the moment it's created —
    // avoids any real waiting in the test while still exercising the actual expiry check.
    const { token } = await repo.create(userId, identityId, -1);

    const session = await repo.findByToken(token);

    assert.equal(session, null, "an expired session must be treated exactly like one that never existed");
  }),
);

test(
  "revoke() invalidates a session immediately",
  withTransaction(async ({ db }) => {
    const { userId, identityId } = await seedUserAndIdentity(db, "agent");
    const repo = new PostgresSessionRepository(db);
    const { token } = await repo.create(userId, identityId, 60);

    await repo.revoke(token);

    assert.equal(await repo.findByToken(token), null);
  }),
);

test(
  "revoke() on a token that was never issued is a harmless no-op",
  withTransaction(async ({ db }) => {
    await assert.doesNotReject(() => new PostgresSessionRepository(db).revoke("mtgs_never-issued"));
  }),
);
