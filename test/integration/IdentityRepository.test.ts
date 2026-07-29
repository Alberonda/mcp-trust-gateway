import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresIdentityRepository } from "../../src/db/IdentityRepository.js";
import { withTransaction } from "./setupDatabase.js";

test(
  "finds an active identity by its api_key_hash",
  withTransaction(async ({ db }) => {
    await db.query(`INSERT INTO identities (name, api_key_hash) VALUES ($1, $2)`, ["alice", "hash-abc"]);

    const identity = await new PostgresIdentityRepository(db).findByApiKeyHash("hash-abc");

    assert.ok(identity);
    assert.equal(identity.name, "alice");
    assert.equal(identity.apiKeyHash, "hash-abc");
    assert.equal(identity.isActive, true);
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
    await db.query(`INSERT INTO identities (name, api_key_hash, is_active) VALUES ($1, $2, false)`, [
      "revoked-agent",
      "hash-revoked",
    ]);

    const identity = await new PostgresIdentityRepository(db).findByApiKeyHash("hash-revoked");

    assert.equal(identity, null, "a deactivated identity must never authenticate, even with a valid hash");
  }),
);
