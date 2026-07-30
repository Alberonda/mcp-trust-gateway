import assert from "node:assert/strict";
import { test } from "node:test";
import type { AllowedTools, PermissionRepository } from "../ports/PermissionRepository.js";
import type { RoleRepository } from "../ports/RoleRepository.js";
import type { NewUpstreamServer, UpstreamServerRepository } from "../ports/UpstreamServerRepository.js";
import type { EncryptedUpstreamCredential, Identity, InvitationToken, Role, UpstreamServer, User } from "./types.js";
import type { InvitationTokenRepository, NewInvitationToken } from "../ports/InvitationTokenRepository.js";
import type { UserCredentialRepository } from "../ports/UserCredentialRepository.js";
import type { UserRepository } from "../ports/UserRepository.js";
import type { ConnectedUpstream, UpstreamConnectionProvider } from "../ports/UpstreamConnectionProvider.js";
import type { NewToolCatalogEntry, ToolCatalogEntry, ToolCatalogRepository } from "../ports/ToolCatalogRepository.js";
import type { Embedder } from "../ports/Embedder.js";
import { AdminToolHandler } from "./AdminToolHandler.js";

const testIdentity: Identity = { id: "identity-1", userId: "user-admin", name: "admin", apiKeyHash: "irrelevant", isActive: true };

class FakeUpstreamConnectionProvider implements UpstreamConnectionProvider {
  public closed = false;
  constructor(private readonly listToolsResult: unknown = { tools: [] }) {}
  async connect(): Promise<ConnectedUpstream> {
    return {
      client: { listTools: async () => this.listToolsResult, callTool: async () => ({ content: [] }) },
      close: async () => {
        this.closed = true;
      },
    };
  }
}

class FailingConnectionProvider implements UpstreamConnectionProvider {
  async connect(): Promise<ConnectedUpstream> {
    throw new Error("connection refused");
  }
}

class FakeToolCatalogRepository implements ToolCatalogRepository {
  public readonly byServer = new Map<string, ToolCatalogEntry[]>();
  async findByServer(serverId: string): Promise<ToolCatalogEntry[]> {
    return this.byServer.get(serverId) ?? [];
  }
  async replaceForServer(serverId: string, entries: readonly NewToolCatalogEntry[]): Promise<void> {
    this.byServer.set(serverId, entries.map((e) => ({ ...e, refreshedAt: new Date() })));
  }
}

class FakeEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    return [text.length];
  }
}

class FakePermissionRepository implements PermissionRepository {
  public readonly grants: { roleId: string; serverId: string; toolName: string | null }[] = [];
  public readonly revokes: { roleId: string; serverId: string; toolName: string | null }[] = [];
  async isCallAllowed(): Promise<boolean> {
    throw new Error("not used in these tests");
  }
  async findAccessibleServerIds(): Promise<string[]> {
    throw new Error("not used in these tests");
  }
  async findAllowedToolNames(): Promise<AllowedTools> {
    throw new Error("not used in these tests");
  }
  async grant(roleId: string, serverId: string, toolName: string | null): Promise<void> {
    this.grants.push({ roleId, serverId, toolName });
  }
  async revoke(roleId: string, serverId: string, toolName: string | null): Promise<void> {
    this.revokes.push({ roleId, serverId, toolName });
  }
}

class FakeInvitationTokenRepository implements InvitationTokenRepository {
  public readonly created: NewInvitationToken[] = [];
  private readonly byHash = new Map<string, InvitationToken>();
  async create(token: NewInvitationToken): Promise<InvitationToken> {
    this.created.push(token);
    const created: InvitationToken = { id: `invitation-${this.created.length}`, roleId: token.roleId, expiresAt: token.expiresAt, usedAt: null };
    this.byHash.set(token.tokenHash, created);
    return created;
  }
  async findByHash(tokenHash: string): Promise<InvitationToken | null> {
    return this.byHash.get(tokenHash) ?? null;
  }
  async markUsed(): Promise<void> {
    throw new Error("not used in these tests");
  }
}

class FakeRoleRepository implements RoleRepository {
  public readonly roles = new Map<string, Role>();
  public readonly userRoles = new Map<string, Set<string>>(); // userId -> roleIds
  public created: { name: string; isAdmin: boolean }[] = [];
  public removed: string[] = [];

  async create(name: string, isAdmin: boolean): Promise<Role> {
    this.created.push({ name, isAdmin });
    const role: Role = { id: `role-${name}`, name, isAdmin };
    this.roles.set(role.id, role);
    return role;
  }
  async findByName(name: string): Promise<Role | null> {
    return [...this.roles.values()].find((r) => r.name === name) ?? null;
  }
  async findById(id: string): Promise<Role | null> {
    return this.roles.get(id) ?? null;
  }
  async listAll(): Promise<Role[]> {
    return [...this.roles.values()];
  }
  async findRolesForUser(userId: string): Promise<Role[]> {
    const ids = this.userRoles.get(userId) ?? new Set();
    return [...this.roles.values()].filter((r) => ids.has(r.id));
  }
  async isUserAdmin(): Promise<boolean> {
    return true;
  }
  async assignToUser(userId: string, roleId: string): Promise<void> {
    const set = this.userRoles.get(userId) ?? new Set();
    set.add(roleId);
    this.userRoles.set(userId, set);
  }
  async unassignFromUser(userId: string, roleId: string): Promise<void> {
    this.userRoles.get(userId)?.delete(roleId);
  }
  async remove(roleId: string): Promise<void> {
    this.removed.push(roleId);
    this.roles.delete(roleId);
  }
}

class FakeUserRepository implements UserRepository {
  public readonly users = new Map<string, User>();
  public removed: string[] = [];
  seed(name: string): User {
    const user = { id: `user-${name}`, name };
    this.users.set(user.id, user);
    return user;
  }
  async create(): Promise<User> {
    throw new Error("not used in these tests");
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
  async remove(userId: string): Promise<void> {
    if (!this.users.has(userId)) throw new Error("not found");
    this.removed.push(userId);
    this.users.delete(userId);
  }
}

class FakeUpstreamServerRepository implements UpstreamServerRepository {
  private readonly servers: UpstreamServer[];
  constructor(initial: readonly UpstreamServer[] = []) {
    this.servers = [...initial];
  }
  async findByName(name: string): Promise<UpstreamServer | null> {
    return this.servers.find((s) => s.name === name) ?? null;
  }
  async findManyByIds(): Promise<UpstreamServer[]> {
    throw new Error("not used in these tests");
  }
  async findAll(): Promise<UpstreamServer[]> {
    return [...this.servers];
  }
  async create(server: NewUpstreamServer): Promise<UpstreamServer> {
    const created: UpstreamServer = { id: `server-${server.name}`, name: server.name, command: server.command, args: server.args, requiresRelay: server.requiresRelay ?? false };
    this.servers.push(created);
    return created;
  }
}

class FakeUserCredentialRepository implements UserCredentialRepository {
  public removed: { userId: string; serverId: string }[] = [];
  async find(): Promise<EncryptedUpstreamCredential | null> {
    return null;
  }
  async upsert(): Promise<void> {}
  async remove(userId: string, serverId: string): Promise<void> {
    this.removed.push({ userId, serverId });
  }
}

function buildHandler(options: { connectionProvider?: UpstreamConnectionProvider; withInvitations?: boolean } = {}) {
  const roles = new FakeRoleRepository();
  const users = new FakeUserRepository();
  const servers = new FakeUpstreamServerRepository([{ id: "s1", name: "sonarqube", command: "irrelevant", args: [], requiresRelay: false }]);
  const credentials = new FakeUserCredentialRepository();
  const permissions = new FakePermissionRepository();
  const connectionProvider = options.connectionProvider ?? new FakeUpstreamConnectionProvider();
  const toolCatalog = new FakeToolCatalogRepository();
  const embedder = new FakeEmbedder();
  const invitationTokens = options.withInvitations ? new FakeInvitationTokenRepository() : undefined;
  const handler = new AdminToolHandler(
    roles,
    users,
    servers,
    credentials,
    permissions,
    connectionProvider,
    toolCatalog,
    embedder,
    testIdentity,
    invitationTokens,
  );
  return { handler, roles, users, servers, credentials, permissions, connectionProvider, toolCatalog, embedder, invitationTokens };
}

test("create_role creates a role and reports it", async () => {
  const { handler, roles } = buildHandler();

  const result = await handler.handle("create_role", { name: "developer", isAdmin: false });

  assert.equal(result.isError, undefined);
  assert.deepEqual(roles.created, [{ name: "developer", isAdmin: false }]);
});

test("assign_role links an existing user to an existing role", async () => {
  const { handler, roles, users } = buildHandler();
  const alice = users.seed("alice");
  await handler.handle("create_role", { name: "developer", isAdmin: false });

  const result = await handler.handle("assign_role", { userName: "alice", roleName: "developer" });

  assert.equal(result.isError, undefined);
  const assigned = await roles.findRolesForUser(alice.id);
  assert.deepEqual(assigned.map((r) => r.name), ["developer"]);
});

test("assign_role fails clearly for an unknown user", async () => {
  const { handler } = buildHandler();
  await handler.handle("create_role", { name: "developer", isAdmin: false });

  const result = await handler.handle("assign_role", { userName: "ghost", roleName: "developer" });

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /No user named/);
});

test("assign_role fails clearly for an unknown role", async () => {
  const { handler, users } = buildHandler();
  users.seed("alice");

  const result = await handler.handle("assign_role", { userName: "alice", roleName: "ghost-role" });

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /No role named/);
});

test("unassign_role removes a previously assigned role", async () => {
  const { handler, roles, users } = buildHandler();
  const alice = users.seed("alice");
  await handler.handle("create_role", { name: "developer", isAdmin: false });
  await handler.handle("assign_role", { userName: "alice", roleName: "developer" });

  await handler.handle("unassign_role", { userName: "alice", roleName: "developer" });

  assert.deepEqual(await roles.findRolesForUser(alice.id), []);
});

test("list_users includes each user's roles", async () => {
  const { handler, users } = buildHandler();
  users.seed("alice");
  await handler.handle("create_role", { name: "developer", isAdmin: false });
  await handler.handle("assign_role", { userName: "alice", roleName: "developer" });

  const result = await handler.handle("list_users", {});

  const parsed = JSON.parse(result.content?.[0]?.text ?? "[]");
  assert.deepEqual(parsed, [{ name: "alice", roles: ["developer"] }]);
});

test("delete_user removes the user", async () => {
  const { handler, users } = buildHandler();
  const alice = users.seed("alice");

  const result = await handler.handle("delete_user", { userName: "alice" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(users.removed, [alice.id]);
});

test("delete_credential removes a user's credential for a named server", async () => {
  const { handler, users, credentials } = buildHandler();
  const alice = users.seed("alice");

  const result = await handler.handle("delete_credential", { userName: "alice", serverName: "sonarqube" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(credentials.removed, [{ userId: alice.id, serverId: "s1" }]);
});

test("delete_role removes the role by name", async () => {
  const { handler, roles } = buildHandler();
  await handler.handle("create_role", { name: "developer", isAdmin: false });

  const result = await handler.handle("delete_role", { name: "developer" });

  assert.equal(result.isError, undefined);
  assert.equal(await roles.findByName("developer"), null);
});

test("an unknown action returns a clear error listing the valid ones", async () => {
  const { handler } = buildHandler();

  const result = await handler.handle("do_something_invalid", {});

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /Unknown action/);
});

test("refresh_catalog connects, lists tools, embeds them, and replaces the server's cache", async () => {
  const connectionProvider = new FakeUpstreamConnectionProvider({ tools: [{ name: "search_issues", description: "Search Jira issues" }] });
  const { handler, toolCatalog } = buildHandler({ connectionProvider });

  const result = await handler.handle("refresh_catalog", { serverName: "sonarqube" });

  assert.equal(result.isError, undefined);
  assert.match(result.content?.[0]?.text ?? "", /1 tool/);
  const entries = await toolCatalog.findByServer("s1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].toolName, "search_issues");
});

test("refresh_catalog closes the connection it opened, even though it only needed it briefly", async () => {
  const connectionProvider = new FakeUpstreamConnectionProvider();
  const { handler } = buildHandler({ connectionProvider });

  await handler.handle("refresh_catalog", { serverName: "sonarqube" });

  assert.equal(connectionProvider.closed, true);
});

test("refresh_catalog on an unknown server returns a clear error instead of connecting to nothing", async () => {
  const { handler } = buildHandler();

  const result = await handler.handle("refresh_catalog", { serverName: "does-not-exist" });

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /No server named/);
});

test("refresh_catalog surfaces a connection failure as a clear error instead of throwing", async () => {
  const { handler } = buildHandler({ connectionProvider: new FailingConnectionProvider() });

  const result = await handler.handle("refresh_catalog", { serverName: "sonarqube" });

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /connection refused/);
});

test("register_server registers a brand new server with no credential and no permission yet", async () => {
  const { handler, servers } = buildHandler();

  const result = await handler.handle("register_server", { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] });

  assert.equal(result.isError, undefined);
  assert.match(result.content?.[0]?.text ?? "", /grant_permission/);
  const registered = await servers.findByName("github");
  assert.ok(registered);
  assert.deepEqual(registered?.args, ["-y", "@modelcontextprotocol/server-github"]);
});

test("register_server refuses to re-register a server name that already exists", async () => {
  const { handler } = buildHandler();

  const result = await handler.handle("register_server", { name: "sonarqube", command: "npx", args: [] });

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /already exists/);
});

test("register_server requires name and command, rejecting a malformed call instead of guessing", async () => {
  const { handler } = buildHandler();

  const result = await handler.handle("register_server", { name: "github" });

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /requires/);
});

test("grant_permission grants blanket access when no toolName is given", async () => {
  const { handler, roles, permissions } = buildHandler();
  await handler.handle("create_role", { name: "developer", isAdmin: false });

  const result = await handler.handle("grant_permission", { roleName: "developer", serverName: "sonarqube" });

  assert.equal(result.isError, undefined);
  const developerRole = await roles.findByName("developer");
  assert.deepEqual(permissions.grants, [{ roleId: developerRole?.id, serverId: "s1", toolName: null }]);
});

test("grant_permission grants a single named tool when toolName is given", async () => {
  const { handler, permissions } = buildHandler();
  await handler.handle("create_role", { name: "developer", isAdmin: false });

  await handler.handle("grant_permission", { roleName: "developer", serverName: "sonarqube", toolName: "system_ping" });

  assert.equal(permissions.grants[0]?.toolName, "system_ping");
});

test("grant_permission rejects an unknown role or server with a clear error", async () => {
  const { handler } = buildHandler();

  const badRole = await handler.handle("grant_permission", { roleName: "does-not-exist", serverName: "sonarqube" });
  const badServer = await handler.handle("grant_permission", { roleName: "developer", serverName: "does-not-exist" });

  assert.equal(badRole.isError, true);
  assert.equal(badServer.isError, true);
});

test("revoke_permission revokes what grant_permission granted", async () => {
  const { handler, roles, permissions } = buildHandler();
  await handler.handle("create_role", { name: "developer", isAdmin: false });
  await handler.handle("grant_permission", { roleName: "developer", serverName: "sonarqube" });

  const result = await handler.handle("revoke_permission", { roleName: "developer", serverName: "sonarqube" });

  assert.equal(result.isError, undefined);
  const developerRole = await roles.findByName("developer");
  assert.deepEqual(permissions.revokes, [{ roleId: developerRole?.id, serverId: "s1", toolName: null }]);
});

test("create_invitation issues a token for the named role with an expiry", async () => {
  const { handler, roles, invitationTokens } = buildHandler({ withInvitations: true });
  await handler.handle("create_role", { name: "basic", isAdmin: false });

  const result = await handler.handle("create_invitation", { roleName: "basic" });

  assert.equal(result.isError, undefined);
  assert.match(result.content?.[0]?.text ?? "", /mtgi_/);
  const basicRole = await roles.findByName("basic");
  assert.equal(invitationTokens?.created.length, 1);
  assert.equal(invitationTokens?.created[0]?.roleId, basicRole?.id);
});

test("create_invitation rejects a role that doesn't exist yet, with a clear error", async () => {
  const { handler } = buildHandler({ withInvitations: true });

  const result = await handler.handle("create_invitation", { roleName: "does-not-exist" });

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /No role named/);
});

test("create_invitation fails clearly in stdio mode, where no InvitationTokenRepository is wired at all", async () => {
  const { handler } = buildHandler({ withInvitations: false });

  const result = await handler.handle("create_invitation", { roleName: "basic" });

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /only available in HTTP mode/);
});
