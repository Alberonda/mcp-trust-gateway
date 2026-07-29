import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresUserCredentialRepository } from "../../src/adapters/postgres/UserCredentialRepository.js";
import { withTransaction } from "./setupDatabase.js";
import { seedServer, seedUserAndIdentity } from "./testFixtures.js";

test(
  "find returns null when the user has no credential for that server",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "alice");
    const serverId = await seedServer(db, "github");

    const credential = await new PostgresUserCredentialRepository(db).find(userId, serverId);

    assert.equal(credential, null);
  }),
);

test(
  "upsert then find round-trips the encrypted fields byte-for-byte",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "alice");
    const serverId = await seedServer(db, "github");
    const credential = { ciphertext: Buffer.from("alice-cipher"), iv: Buffer.from("alice-iv-12b"), authTag: Buffer.from("alice-auth-tag16") };

    await new PostgresUserCredentialRepository(db).upsert(userId, serverId, credential);
    const found = await new PostgresUserCredentialRepository(db).find(userId, serverId);

    assert.ok(found);
    assert.ok(credential.ciphertext.equals(found.ciphertext));
    assert.ok(credential.iv.equals(found.iv));
    assert.ok(credential.authTag.equals(found.authTag));
  }),
);

test(
  "upsert replaces an existing credential in place rather than creating a second row",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "alice");
    const serverId = await seedServer(db, "github");
    const repo = new PostgresUserCredentialRepository(db);
    await repo.upsert(userId, serverId, { ciphertext: Buffer.from("old"), iv: Buffer.from("old-iv-12by"), authTag: Buffer.from("old-auth-tag-16b") });

    const newCredential = { ciphertext: Buffer.from("new"), iv: Buffer.from("new-iv-12by"), authTag: Buffer.from("new-auth-tag-16b") };
    await repo.upsert(userId, serverId, newCredential);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM user_credentials WHERE user_id = $1 AND server_id = $2`,
      [userId, serverId],
    );
    assert.equal(rows[0].count, "1");
    const found = await repo.find(userId, serverId);
    assert.ok(newCredential.ciphertext.equals(found!.ciphertext));
  }),
);

test(
  "two different users can each have their own credential for the same server",
  withTransaction(async ({ db }) => {
    const alice = await seedUserAndIdentity(db, "alice");
    const bob = await seedUserAndIdentity(db, "bob");
    const serverId = await seedServer(db, "github");
    const repo = new PostgresUserCredentialRepository(db);
    const aliceCredential = { ciphertext: Buffer.from("alice-token"), iv: Buffer.from("alice-iv-12b"), authTag: Buffer.from("alice-auth-tag16") };
    const bobCredential = { ciphertext: Buffer.from("bob-token--"), iv: Buffer.from("bob-iv--12by"), authTag: Buffer.from("bob-auth-tag-16b") };

    await repo.upsert(alice.userId, serverId, aliceCredential);
    await repo.upsert(bob.userId, serverId, bobCredential);

    const aliceFound = await repo.find(alice.userId, serverId);
    const bobFound = await repo.find(bob.userId, serverId);
    assert.ok(aliceCredential.ciphertext.equals(aliceFound!.ciphertext));
    assert.ok(bobCredential.ciphertext.equals(bobFound!.ciphertext));
  }),
);

test(
  "remove() reverts the user to having no credential for that server, and is a harmless no-op if none existed",
  withTransaction(async ({ db }) => {
    const { userId } = await seedUserAndIdentity(db, "alice");
    const serverId = await seedServer(db, "github");
    const repo = new PostgresUserCredentialRepository(db);
    await repo.upsert(userId, serverId, { ciphertext: Buffer.from("c"), iv: Buffer.from("iv-12-bytes."), authTag: Buffer.from("auth-tag-16-byte") });

    await repo.remove(userId, serverId);
    await repo.remove(userId, serverId); // second call must not throw

    assert.equal(await repo.find(userId, serverId), null);
  }),
);
