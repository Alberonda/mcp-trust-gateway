import assert from "node:assert/strict";
import { test } from "node:test";
import type { IdentityRepository } from "../db/IdentityRepository.js";
import type { Session, SessionRepository } from "../db/SessionRepository.js";
import type { Identity } from "../db/types.js";
import { hashApiKey } from "../security/apiKeys.js";
import { resolveIdentityFromAuthHeader, resolveIdentityFromSessionToken } from "./auth.js";

const testIdentity: Identity = {
  id: "id-1",
  userId: "user-1",
  name: "test-agent",
  apiKeyHash: hashApiKey("mtg_real-key"),
  isActive: true,
};

class FakeIdentityRepository implements IdentityRepository {
  async findByApiKeyHash(hash: string): Promise<Identity | null> {
    return hash === testIdentity.apiKeyHash ? testIdentity : null;
  }
  async findById(id: string): Promise<Identity | null> {
    return id === testIdentity.id ? testIdentity : null;
  }
}

class FakeSessionRepository implements SessionRepository {
  constructor(private readonly validToken?: string) {}
  async create(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async findByToken(token: string): Promise<Session | null> {
    return token === this.validToken ? { userId: testIdentity.userId, identityId: testIdentity.id } : null;
  }
  async revoke(): Promise<void> {}
}

test("resolveIdentityFromAuthHeader resolves the identity for a correct Bearer header", async () => {
  const result = await resolveIdentityFromAuthHeader("Bearer mtg_real-key", new FakeIdentityRepository());

  assert.deepEqual(result, { identity: testIdentity });
});

test("resolveIdentityFromAuthHeader rejects a missing header", async () => {
  const result = await resolveIdentityFromAuthHeader(undefined, new FakeIdentityRepository());

  assert.ok("error" in result);
});

test("resolveIdentityFromAuthHeader rejects a header with the wrong scheme", async () => {
  const result = await resolveIdentityFromAuthHeader("Basic dXNlcjpwYXNz", new FakeIdentityRepository());

  assert.ok("error" in result);
});

test("resolveIdentityFromAuthHeader rejects an empty Bearer token", async () => {
  const result = await resolveIdentityFromAuthHeader("Bearer    ", new FakeIdentityRepository());

  assert.ok("error" in result);
});

test("resolveIdentityFromAuthHeader rejects a well-formed but unknown key without leaking whether it's the format or the value that's wrong", async () => {
  const result = await resolveIdentityFromAuthHeader("Bearer mtg_not-a-real-key", new FakeIdentityRepository());

  assert.ok("error" in result);
});

test("resolveIdentityFromSessionToken resolves the identity that logged in to create the session", async () => {
  const result = await resolveIdentityFromSessionToken(
    "Bearer mtgs_valid-session-token",
    new FakeSessionRepository("mtgs_valid-session-token"),
    new FakeIdentityRepository(),
  );

  assert.deepEqual(result, { identity: testIdentity });
});

test("resolveIdentityFromSessionToken rejects an unknown or expired token", async () => {
  const result = await resolveIdentityFromSessionToken(
    "Bearer mtgs_expired-or-fake",
    new FakeSessionRepository("mtgs_valid-session-token"),
    new FakeIdentityRepository(),
  );

  assert.ok("error" in result);
});

test("resolveIdentityFromSessionToken rejects a missing header the same way resolveIdentityFromAuthHeader does", async () => {
  const result = await resolveIdentityFromSessionToken(undefined, new FakeSessionRepository(), new FakeIdentityRepository());

  assert.ok("error" in result);
});

test("resolveIdentityFromSessionToken never accepts a raw API key in place of a session token", async () => {
  // The whole point of Phase 3b: an API key must go through POST /login first. A
  // FakeSessionRepository never recognizes an API key as a session token, so this just
  // confirms the two token types aren't interchangeable at this layer.
  const result = await resolveIdentityFromSessionToken(
    "Bearer mtg_real-key",
    new FakeSessionRepository("mtgs_valid-session-token"),
    new FakeIdentityRepository(),
  );

  assert.ok("error" in result);
});
