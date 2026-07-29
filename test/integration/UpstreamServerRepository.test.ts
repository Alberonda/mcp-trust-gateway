import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresUpstreamServerRepository } from "../../src/db/UpstreamServerRepository.js";
import { withTransaction } from "./setupDatabase.js";

test(
  "finds a server with no credential (e.g. the filesystem server)",
  withTransaction(async ({ db }) => {
    await db.query(`INSERT INTO upstream_servers (name, command) VALUES ($1, $2)`, [
      "filesystem",
      "npx -y @modelcontextprotocol/server-filesystem /tmp",
    ]);

    const server = await new PostgresUpstreamServerRepository(db).findByName("filesystem");

    assert.ok(server);
    assert.equal(server.command, "npx -y @modelcontextprotocol/server-filesystem /tmp");
    assert.equal(server.credential, null);
  }),
);

test(
  "finds a server's encrypted credential fields byte-for-byte",
  withTransaction(async ({ db }) => {
    const ciphertext = Buffer.from("ciphertext-bytes");
    const iv = Buffer.from("iv-bytes-12b");
    const authTag = Buffer.from("auth-tag-bytes-16");

    await db.query(
      `INSERT INTO upstream_servers (name, command, encrypted_credential, credential_iv, credential_auth_tag)
       VALUES ($1, $2, $3, $4, $5)`,
      ["github", "npx -y @modelcontextprotocol/server-github", ciphertext, iv, authTag],
    );

    const server = await new PostgresUpstreamServerRepository(db).findByName("github");

    assert.ok(server?.credential);
    assert.ok(ciphertext.equals(server.credential.ciphertext));
    assert.ok(iv.equals(server.credential.iv));
    assert.ok(authTag.equals(server.credential.authTag));
  }),
);

test(
  "returns null for an unregistered server name",
  withTransaction(async ({ db }) => {
    const server = await new PostgresUpstreamServerRepository(db).findByName("does-not-exist");

    assert.equal(server, null);
  }),
);

test(
  "findManyByIds resolves several servers in one call, in no particular guaranteed order",
  withTransaction(async ({ db }) => {
    const {
      rows: [a],
    } = await db.query<{ id: string }>(`INSERT INTO upstream_servers (name, command) VALUES ('a', 'cmd-a') RETURNING id`);
    const {
      rows: [b],
    } = await db.query<{ id: string }>(`INSERT INTO upstream_servers (name, command) VALUES ('b', 'cmd-b') RETURNING id`);
    await db.query(`INSERT INTO upstream_servers (name, command) VALUES ('c', 'cmd-c')`); // deliberately not requested

    const servers = await new PostgresUpstreamServerRepository(db).findManyByIds([a.id, b.id]);

    assert.deepEqual(new Set(servers.map((s) => s.name)), new Set(["a", "b"]));
  }),
);

test(
  "findManyByIds returns an empty array for an empty input, without querying",
  withTransaction(async ({ db }) => {
    const servers = await new PostgresUpstreamServerRepository(db).findManyByIds([]);

    assert.deepEqual(servers, []);
  }),
);
