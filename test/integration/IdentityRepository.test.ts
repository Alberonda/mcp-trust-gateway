import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresIdentityRepository } from "../../src/db/IdentityRepository.js";
import { withTransaction } from "./setupDatabase.js";

test(
  "finds an active identity by its api_key_hash, including its owning user's id",
  withTransaction(async ({ db }) => {
    const {
      rows: [user],
    } = await db.query<{ id: string }>(`INSERT INTO users (name) VALUES ('alice') RETURNING id`);
    await db.query(`INSERT INTO identities (user_id, name, api_key_hash) VALUES ($1, $2, $3)`, [
      user.id,
      "alice",
      "hash-abc",
    ]);

    const identity = await new PostgresIdentityRepository(db).findByApiKeyHash("hash-abc");

    assert.ok(identity);
    assert.equal(identity.name, "alice");
    assert.equal(identity.apiKeyHash, "hash-abc");
    assert.equal(identity.isActive, true);
    assert.equal(identity.userId, user.id);
  }),
);

test(
  "returns null for a hash that matches no identity",
  withTransaction(async ({ db }) => {
    const identity = await new PostgresIdentityRepository(db).findByApiKeyHash("no-such-hash");

    assert.equal(identity, null);
  }),
);

test(
  "returns null for a deactivated identity, even with the correct hash",
  withTransaction(async ({ db }) => {
    const {
      rows: [user],
    } = await db.query<{ id: string }>(`INSERT INTO users (name) VALUES ('revoked-agent') RETURNING id`);
    await db.query(`INSERT INTO identities (user_id, name, api_key_hash, is_active) VALUES ($1, $2, $3, false)`, [
      user.id,
      "revoked-agent",
      "hash-revoked",
    ]);

    const identity = await new PostgresIdentityRepository(db).findByApiKeyHash("hash-revoked");

    assert.equal(identity, null, "a deactivated identity must never authenticate, even with a valid hash");
  }),
);
