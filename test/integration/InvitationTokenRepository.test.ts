import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresInvitationTokenRepository } from "../../src/adapters/postgres/InvitationTokenRepository.js";
import { withTransaction } from "./setupDatabase.js";
import { seedRole, seedUserAndIdentity } from "./testFixtures.js";

test(
  "create() then findByHash() round-trips roleId, expiresAt, and starts unused",
  withTransaction(async ({ db }) => {
    const roleId = await seedRole(db);
    const expiresAt = new Date(Date.now() + 60_000);
    const repo = new PostgresInvitationTokenRepository(db);

    const created = await repo.create({ tokenHash: "hash-1", roleId, createdBy: null, expiresAt });
    const found = await repo.findByHash("hash-1");

    assert.equal(found?.id, created.id);
    assert.equal(found?.roleId, roleId);
    assert.equal(found?.usedAt, null);
    assert.equal(found?.expiresAt.getTime(), expiresAt.getTime());
  }),
);

test(
  "findByHash returns null for a hash that was never created",
  withTransaction(async ({ db }) => {
    const found = await new PostgresInvitationTokenRepository(db).findByHash("never-created");

    assert.equal(found, null);
  }),
);

test(
  "markUsed sets usedAt and usedBy, reflected in a subsequent findByHash",
  withTransaction(async ({ db }) => {
    const roleId = await seedRole(db);
    const { userId } = await seedUserAndIdentity(db, "redeemer");
    const repo = new PostgresInvitationTokenRepository(db);
    const created = await repo.create({ tokenHash: "hash-2", roleId, createdBy: null, expiresAt: new Date(Date.now() + 60_000) });

    await repo.markUsed(created.id, userId);

    const found = await repo.findByHash("hash-2");
    assert.ok(found?.usedAt instanceof Date);
    const { rows } = await db.query(`SELECT used_by AS "usedBy" FROM invitation_tokens WHERE id = $1`, [created.id]);
    assert.equal(rows[0]?.usedBy, userId);
  }),
);

test(
  "markUsed throws for a token id that doesn't exist, rather than silently no-op-ing",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "redeemer");

    await assert.rejects(() => new PostgresInvitationTokenRepository(db).markUsed("00000000-0000-0000-0000-000000000000", userId));
  }),
);

test(
  "deleting the role a token belongs to cascades to the token (matches migrations/010's ON DELETE CASCADE)",
  withTransaction(async ({ db }) => {
    const roleId = await seedRole(db);
    const repo = new PostgresInvitationTokenRepository(db);
    await repo.create({ tokenHash: "hash-3", roleId, createdBy: null, expiresAt: new Date(Date.now() + 60_000) });

    await db.query(`DELETE FROM roles WHERE id = $1`, [roleId]);

    assert.equal(await repo.findByHash("hash-3"), null);
  }),
);
