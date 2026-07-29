import assert from "node:assert/strict";
import { test } from "node:test";
import type { IdentityRepository } from "../db/IdentityRepository.js";
import type { Identity } from "../db/types.js";
import { hashApiKey } from "../security/apiKeys.js";
import { resolveIdentityFromAuthHeader } from "./auth.js";

const testIdentity: Identity = { id: "id-1", name: "test-agent", apiKeyHash: hashApiKey("mtg_real-key"), isActive: true };

class FakeIdentityRepository implements IdentityRepository {
  async findByApiKeyHash(hash: string): Promise<Identity | null> {
    return hash === testIdentity.apiKeyHash ? testIdentity : null;
  }
}

test("resolves the identity for a correct Bearer header", async () => {
  const result = await resolveIdentityFromAuthHeader("Bearer mtg_real-key", new FakeIdentityRepository());

  assert.deepEqual(result, { identity: testIdentity });
});

test("rejects a missing header", async () => {
  const result = await resolveIdentityFromAuthHeader(undefined, new FakeIdentityRepository());

  assert.ok("error" in result);
});

test("rejects a header with the wrong scheme", async () => {
  const result = await resolveIdentityFromAuthHeader("Basic dXNlcjpwYXNz", new FakeIdentityRepository());

  assert.ok("error" in result);
});

test("rejects an empty Bearer token", async () => {
  const result = await resolveIdentityFromAuthHeader("Bearer    ", new FakeIdentityRepository());

  assert.ok("error" in result);
});

test("rejects a well-formed but unknown key without leaking whether it's the format or the value that's wrong", async () => {
  const result = await resolveIdentityFromAuthHeader("Bearer mtg_not-a-real-key", new FakeIdentityRepository());

  assert.ok("error" in result);
});
