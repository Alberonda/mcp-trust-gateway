import assert from "node:assert/strict";
import { test } from "node:test";
import { hashInvitationToken } from "../adapters/security/invitationTokens.js";
import type { InvitationTokenRepository, NewInvitationToken } from "../ports/InvitationTokenRepository.js";
import type { RoleRepository } from "../ports/RoleRepository.js";
import type { IdentityRepository } from "../ports/IdentityRepository.js";
import type { UserRepository } from "../ports/UserRepository.js";
import type { Identity, InvitationToken, Role, User } from "./types.js";
import { InvitationRedemptionHandler } from "./InvitationRedemptionHandler.js";

const ROLE_ID = "role-basic";
const VALID_TOKEN_PLAINTEXT = "mtgi_a-real-looking-token";

class FakeInvitationTokenRepository implements InvitationTokenRepository {
  private readonly byHash = new Map<string, InvitationToken>();
  public readonly markUsedCalls: { tokenId: string; usedBy: string }[] = [];

  seed(plaintext: string, token: InvitationToken): void {
    this.byHash.set(hashInvitationToken(plaintext), token);
  }

  async create(token: NewInvitationToken): Promise<InvitationToken> {
    const created: InvitationToken = { id: "new-token", roleId: token.roleId, expiresAt: token.expiresAt, usedAt: null };
    this.byHash.set(token.tokenHash, created);
    return created;
  }
  async findByHash(tokenHash: string): Promise<InvitationToken | null> {
    return this.byHash.get(tokenHash) ?? null;
  }
  async markUsed(tokenId: string, usedBy: string): Promise<void> {
    this.markUsedCalls.push({ tokenId, usedBy });
  }
}

class FakeUserRepository implements UserRepository {
  public readonly users = new Map<string, User>();
  public created: string[] = [];
  seed(name: string): User {
    const user = { id: `user-${name}`, name };
    this.users.set(user.id, user);
    return user;
  }
  async create(name: string): Promise<User> {
    this.created.push(name);
    const user = { id: `user-${name}`, name };
    this.users.set(user.id, user);
    return user;
  }
  async findById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }
  async findByName(name: string): Promise<User | null> {
    return [...this.users.values()].find((u) => u.name === name) ?? null;
  }
  async listAll(): Promise<User[]> {
    return [...this.users.values()];
  }
  async remove(): Promise<void> {
    throw new Error("not used in these tests");
  }
}

class FakeIdentityRepository implements IdentityRepository {
  public created: { userId: string; name: string; apiKeyHash: string }[] = [];
  async findByApiKeyHash(): Promise<Identity | null> {
    throw new Error("not used in these tests");
  }
  async findById(): Promise<Identity | null> {
    throw new Error("not used in these tests");
  }
  async create(userId: string, name: string, apiKeyHash: string): Promise<Identity> {
    this.created.push({ userId, name, apiKeyHash });
    return { id: "new-identity", userId, name, apiKeyHash, isActive: true };
  }
}

class FakeRoleRepository implements RoleRepository {
  public assigned: { userId: string; roleId: string }[] = [];
  async create(): Promise<Role> {
    throw new Error("not used in these tests");
  }
  async findByName(): Promise<Role | null> {
    throw new Error("not used in these tests");
  }
  async findById(): Promise<Role | null> {
    throw new Error("not used in these tests");
  }
  async listAll(): Promise<Role[]> {
    throw new Error("not used in these tests");
  }
  async findRolesForUser(): Promise<Role[]> {
    throw new Error("not used in these tests");
  }
  async isUserAdmin(): Promise<boolean> {
    throw new Error("not used in these tests");
  }
  async assignToUser(userId: string, roleId: string): Promise<void> {
    this.assigned.push({ userId, roleId });
  }
  async unassignFromUser(): Promise<void> {
    throw new Error("not used in these tests");
  }
  async remove(): Promise<void> {
    throw new Error("not used in these tests");
  }
}

function buildHandler() {
  const invitationTokens = new FakeInvitationTokenRepository();
  const users = new FakeUserRepository();
  const identities = new FakeIdentityRepository();
  const roles = new FakeRoleRepository();
  const handler = new InvitationRedemptionHandler(invitationTokens, users, identities, roles);
  return { handler, invitationTokens, users, identities, roles };
}

test("redeem() with a valid, unused, unexpired token creates a user, an identity, and assigns the role", async () => {
  const { handler, invitationTokens, users, identities, roles } = buildHandler();
  invitationTokens.seed(VALID_TOKEN_PLAINTEXT, { id: "token-1", roleId: ROLE_ID, expiresAt: new Date(Date.now() + 60_000), usedAt: null });

  const result = await handler.redeem(VALID_TOKEN_PLAINTEXT, "new-teammate");

  assert.ok("apiKey" in result, `expected success, got ${JSON.stringify(result)}`);
  assert.match((result as { apiKey: string }).apiKey, /^mtg_/);
  assert.deepEqual(users.created, ["new-teammate"]);
  const newUser = await users.findByName("new-teammate");
  assert.equal(identities.created[0]?.userId, newUser?.id);
  assert.deepEqual(roles.assigned, [{ userId: newUser?.id, roleId: ROLE_ID }]);
  assert.deepEqual(invitationTokens.markUsedCalls, [{ tokenId: "token-1", usedBy: newUser?.id }]);
});

test("redeem() rejects a token that doesn't exist at all", async () => {
  const { handler } = buildHandler();

  const result = await handler.redeem("mtgi_totally-made-up", "someone");

  assert.deepEqual(result, { error: "Invalid invitation token." });
});

test("redeem() rejects a token that's already been used, even with the correct plaintext", async () => {
  const { handler, invitationTokens } = buildHandler();
  invitationTokens.seed(VALID_TOKEN_PLAINTEXT, { id: "token-1", roleId: ROLE_ID, expiresAt: new Date(Date.now() + 60_000), usedAt: new Date() });

  const result = await handler.redeem(VALID_TOKEN_PLAINTEXT, "someone");

  assert.deepEqual(result, { error: "This invitation token has already been used — ask an admin for a new one." });
});

test("redeem() rejects an expired token", async () => {
  const { handler, invitationTokens } = buildHandler();
  invitationTokens.seed(VALID_TOKEN_PLAINTEXT, { id: "token-1", roleId: ROLE_ID, expiresAt: new Date(Date.now() - 1000), usedAt: null });

  const result = await handler.redeem(VALID_TOKEN_PLAINTEXT, "someone");

  assert.deepEqual(result, { error: "This invitation token has expired — ask an admin for a new one." });
});

test("redeem() rejects a name that's already taken, without ever creating a duplicate user", async () => {
  const { handler, invitationTokens, users } = buildHandler();
  invitationTokens.seed(VALID_TOKEN_PLAINTEXT, { id: "token-1", roleId: ROLE_ID, expiresAt: new Date(Date.now() + 60_000), usedAt: null });
  users.seed("already-taken");

  const result = await handler.redeem(VALID_TOKEN_PLAINTEXT, "already-taken");

  assert.deepEqual(result, { error: 'The name "already-taken" is already taken — choose a different one and try again.' });
  assert.deepEqual(users.created, [], "must not create a second user with the same name");
});
