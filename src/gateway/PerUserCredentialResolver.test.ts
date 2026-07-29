import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserCredentialRepository } from "../db/UserCredentialRepository.js";
import type { EncryptedUpstreamCredential, UpstreamServer } from "../db/types.js";
import { PerUserCredentialResolver } from "./PerUserCredentialResolver.js";

const defaultCredential: EncryptedUpstreamCredential = {
  ciphertext: Buffer.from("default-cipher"),
  iv: Buffer.from("default-iv-12b"),
  authTag: Buffer.from("default-auth-tag"),
};
const userOverride: EncryptedUpstreamCredential = {
  ciphertext: Buffer.from("override-cipher"),
  iv: Buffer.from("override-iv-1b"),
  authTag: Buffer.from("override-auth-t"),
};
const server: UpstreamServer = {
  id: "server-1",
  name: "github",
  command: "npx",
  args: ["-y", "server-github"],
  credential: defaultCredential,
};

class FakeUserCredentialRepository implements UserCredentialRepository {
  constructor(private readonly overrides: Record<string, EncryptedUpstreamCredential>) {}
  async findOverride(userId: string, serverId: string): Promise<EncryptedUpstreamCredential | null> {
    return this.overrides[`${userId}:${serverId}`] ?? null;
  }
  async upsert(): Promise<void> {
    throw new Error("not used in these tests");
  }
  async remove(): Promise<void> {
    throw new Error("not used in these tests");
  }
}

test("uses the user's own override when one exists, instead of the server's default", async () => {
  const resolver = new PerUserCredentialResolver(new FakeUserCredentialRepository({ "user-1:server-1": userOverride }));

  const resolved = await resolver.resolve(server, "user-1");

  assert.equal(resolved.credential, userOverride);
});

test("falls back to the server's own default when the user has no override", async () => {
  const resolver = new PerUserCredentialResolver(new FakeUserCredentialRepository({}));

  const resolved = await resolver.resolve(server, "user-1");

  assert.equal(resolved.credential, defaultCredential);
});

test("never mutates the original server object", async () => {
  const resolver = new PerUserCredentialResolver(new FakeUserCredentialRepository({ "user-1:server-1": userOverride }));

  await resolver.resolve(server, "user-1");

  assert.equal(server.credential, defaultCredential, "resolving for one user must never change what other users/sessions see");
});

test("one user's override never leaks to a different user for the same server", async () => {
  const resolver = new PerUserCredentialResolver(new FakeUserCredentialRepository({ "user-1:server-1": userOverride }));

  const resolvedForOtherUser = await resolver.resolve(server, "user-2");

  assert.equal(resolvedForOtherUser.credential, defaultCredential);
});

test("preserves every other field on the server unchanged", async () => {
  const resolver = new PerUserCredentialResolver(new FakeUserCredentialRepository({ "user-1:server-1": userOverride }));

  const resolved = await resolver.resolve(server, "user-1");

  assert.equal(resolved.id, server.id);
  assert.equal(resolved.name, server.name);
  assert.equal(resolved.command, server.command);
  assert.deepEqual(resolved.args, server.args);
});
