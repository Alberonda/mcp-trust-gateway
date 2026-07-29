import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresUpstreamServerRepository } from "../../src/db/UpstreamServerRepository.js";
import { withTransaction } from "./setupDatabase.js";

test(
  "finds a server with no credential and no args (e.g. the filesystem server)",
  withTransaction(async ({ db }) => {
    await db.query(`INSERT INTO upstream_servers (name, command) VALUES ($1, $2)`, ["filesystem", "npx"]);

    const server = await new PostgresUpstreamServerRepository(db).findByName("filesystem");

    assert.ok(server);
    assert.equal(server.command, "npx");
    assert.deepEqual(server.args, []);
    assert.equal(server.credential, null);
  }),
);

test(
  "finds a server's args in the order they were stored",
  withTransaction(async ({ db }) => {
    await db.query(`INSERT INTO upstream_servers (name, command, args) VALUES ($1, $2, $3)`, [
      "filesystem-scoped",
      "npx",
      JSON.stringify(["-y", "@modelcontextprotocol/server-filesystem", "/tmp/sandbox"]),
    ]);

    const server = await new PostgresUpstreamServerRepository(db).findByName("filesystem-scoped");

    assert.deepEqual(server?.args, ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/sandbox"]);
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
      ["github", "npx", ciphertext, iv, authTag],
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

test(
  "create() registers a server with the standard {command, args, env} shape, env already encrypted",
  withTransaction(async ({ db }) => {
    const encryptedEnv = { ciphertext: Buffer.from("cipher"), iv: Buffer.from("iv-12-bytes."), authTag: Buffer.from("auth-tag-16-byte") };

    const created = await new PostgresUpstreamServerRepository(db).create({
      name: "sonarqube",
      command: "docker",
      args: ["run", "--init", "-i", "--rm", "mcp/sonarqube-mb"],
      encryptedEnv,
    });

    assert.equal(created.name, "sonarqube");
    assert.equal(created.command, "docker");
    assert.deepEqual(created.args, ["run", "--init", "-i", "--rm", "mcp/sonarqube-mb"]);
    assert.ok(created.credential);
    assert.ok(encryptedEnv.ciphertext.equals(created.credential.ciphertext));
  }),
);

test(
  "create() defaults to no args and no credential when neither is given",
  withTransaction(async ({ db }) => {
    const created = await new PostgresUpstreamServerRepository(db).create({ name: "memory", command: "npx", args: [] });

    assert.deepEqual(created.args, []);
    assert.equal(created.credential, null);
  }),
);

test(
  "updateEnv replaces the encrypted fields in place, keeping the same id/name/args",
  withTransaction(async ({ db }) => {
    const {
      rows: [server],
    } = await db.query<{ id: string }>(
      `INSERT INTO upstream_servers (name, command, args, encrypted_credential, credential_iv, credential_auth_tag)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      ["github", "npx", JSON.stringify(["-y", "server-github"]), Buffer.from("old-cipher"), Buffer.from("old-iv-12by"), Buffer.from("old-auth-tag-16b")],
    );
    const repo = new PostgresUpstreamServerRepository(db);
    const newEnv = { ciphertext: Buffer.from("new-cipher"), iv: Buffer.from("new-iv-12by"), authTag: Buffer.from("new-auth-tag-16b") };

    await repo.updateEnv(server.id, newEnv);

    const updated = await repo.findByName("github");
    assert.equal(updated?.id, server.id, "rotating env vars must never change the server's id");
    assert.deepEqual(updated?.args, ["-y", "server-github"], "rotating env vars must never change args");
    assert.ok(newEnv.ciphertext.equals(updated!.credential!.ciphertext));
    assert.ok(newEnv.iv.equals(updated!.credential!.iv));
    assert.ok(newEnv.authTag.equals(updated!.credential!.authTag));
  }),
);

test(
  "updateEnv throws for a server id that doesn't exist, instead of silently doing nothing",
  withTransaction(async ({ db }) => {
    const repo = new PostgresUpstreamServerRepository(db);
    const fakeEnv = { ciphertext: Buffer.from("c"), iv: Buffer.from("i"), authTag: Buffer.from("a") };

    await assert.rejects(() => repo.updateEnv("00000000-0000-0000-0000-000000000000", fakeEnv));
  }),
);
