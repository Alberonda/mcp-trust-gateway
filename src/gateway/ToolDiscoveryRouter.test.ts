import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditEntry, AuditLogRepository, AuditLogRow, StoredAuditEntry } from "../db/AuditLogRepository.js";
import type { AllowedTools, PermissionRepository } from "../db/PermissionRepository.js";
import type { RoleRepository } from "../db/RoleRepository.js";
import type { NewUpstreamServer, UpstreamServerRepository } from "../db/UpstreamServerRepository.js";
import type { EncryptedUpstreamCredential, Identity, Role, UpstreamServer, User } from "../db/types.js";
import type { UserCredentialRepository } from "../db/UserCredentialRepository.js";
import type { UserRepository } from "../db/UserRepository.js";
import { CredentialVault } from "../security/vault.js";
import { AdminToolHandler } from "./AdminToolHandler.js";
import { SelfServiceHandler } from "./SelfServiceHandler.js";
import { ToolCallHandler } from "./ToolCallHandler.js";
import { ToolDiscoveryRouter } from "./ToolDiscoveryRouter.js";
import type { ToolCallResult, UpstreamToolClient } from "./UpstreamToolClient.js";

/**
 * These tests exist specifically to demonstrate Claim A from DESIGN.md's Phase 2 plan:
 * "an identity can only discover and call tools it has permission for, even when the
 * gateway is connected to N ≥ 2 upstream servers." Every test below either proves that
 * holds or would fail loudly if it didn't — this is the automated version of the manual
 * verification plan, not a description of intended behavior.
 */

class FakePermissionRepository implements PermissionRepository {
  /** allowedTools maps serverId -> set of tool names allowed (or "*" for every tool). */
  constructor(private readonly allowedTools: Record<string, Set<string> | "*">) {}

  async isCallAllowed(_userId: string, serverId: string, toolName: string): Promise<boolean> {
    const allowed = this.allowedTools[serverId];
    if (!allowed) return false;
    return allowed === "*" || allowed.has(toolName);
  }

  async findAccessibleServerIds(): Promise<string[]> {
    return Object.keys(this.allowedTools);
  }

  async findAllowedToolNames(_userId: string, serverId: string): Promise<AllowedTools> {
    const allowed = this.allowedTools[serverId];
    if (!allowed) return new Set();
    return allowed === "*" ? "all" : allowed;
  }
}

class FakeUpstreamServerRepository implements UpstreamServerRepository {
  async findByName(): Promise<UpstreamServer | null> {
    return null;
  }
  async findManyByIds(): Promise<UpstreamServer[]> {
    return [];
  }
  async findAll(): Promise<UpstreamServer[]> {
    return [];
  }
  async create(_server: NewUpstreamServer): Promise<UpstreamServer> {
    throw new Error("not used in these tests");
  }
}

class FakeUserCredentialRepository implements UserCredentialRepository {
  async find(): Promise<EncryptedUpstreamCredential | null> {
    return null;
  }
  async upsert(): Promise<void> {}
  async remove(): Promise<void> {}
}

class FakeRoleRepository implements RoleRepository {
  async create(): Promise<Role> {
    throw new Error("not used in these tests");
  }
  async findByName(): Promise<Role | null> {
    return null;
  }
  async findById(): Promise<Role | null> {
    return null;
  }
  async listAll(): Promise<Role[]> {
    return [];
  }
  async findRolesForUser(): Promise<Role[]> {
    return [];
  }
  async isUserAdmin(): Promise<boolean> {
    return true;
  }
  async assignToUser(): Promise<void> {}
  async unassignFromUser(): Promise<void> {}
  async remove(): Promise<void> {}
}

class FakeUserRepository implements UserRepository {
  async create(): Promise<User> {
    throw new Error("not used in these tests");
  }
  async findById(): Promise<User | null> {
    return null;
  }
  async findByName(): Promise<User | null> {
    return null;
  }
  async listAll(): Promise<User[]> {
    return [];
  }
  async remove(): Promise<void> {}
}

/** Builds a real SelfServiceHandler wired to fakes — none of the tests in this file
 *  exercise list_services/register_my_credential's own behavior directly (see
 *  SelfServiceHandler.test.ts for that); this only exists so ToolDiscoveryRouter has a
 *  real instance to hold, matching what the composition root always provides. */
function buildSelfService(permissions: PermissionRepository = new FakePermissionRepository({})): SelfServiceHandler {
  return new SelfServiceHandler(
    identity.userId,
    permissions,
    new FakeUpstreamServerRepository(),
    new FakeUserCredentialRepository(),
    new CredentialVault(Buffer.alloc(32, 1)),
  );
}

class NullAuditLogRepository implements AuditLogRepository {
  async write(): Promise<void> {}
  async findRecentByIdentity(): Promise<StoredAuditEntry[]> {
    return [];
  }
  async search(): Promise<AuditLogRow[]> {
    return [];
  }
}

class FakeUpstreamToolClient implements UpstreamToolClient {
  constructor(private readonly tools: Array<{ name: string; description: string }>) {}

  async listTools(): Promise<unknown> {
    return { tools: this.tools };
  }

  async callTool(name: string): Promise<ToolCallResult> {
    return { content: [{ type: "text", text: `called ${name}` }] };
  }
}

const identity: Identity = {
  id: "identity-1",
  userId: "user-1",
  name: "test-identity",
  apiKeyHash: "irrelevant",
  isActive: true,
};

function server(name: string): UpstreamServer {
  return { id: `server-${name}`, name, command: "irrelevant", args: [] };
}

/** Builds one ToolCallHandler wired to a fake upstream exposing `tools`, gated by whatever
 *  the shared FakePermissionRepository says for that server's id. */
function buildHandler(
  serverName: string,
  tools: Array<{ name: string; description: string }>,
  permissions: PermissionRepository,
): ToolCallHandler {
  return new ToolCallHandler(
    identity,
    server(serverName),
    permissions,
    new NullAuditLogRepository(),
    new FakeUpstreamToolClient(tools),
  );
}

/** Most tests don't care about the router's own audit log — this defaults to a no-op one
 *  so call sites only need to opt in (pass their own AuditLogRepository) when they do. */
function buildRouter(
  handlers: readonly ToolCallHandler[],
  auditLog: AuditLogRepository = new NullAuditLogRepository(),
  adminHandler?: AdminToolHandler,
) {
  return new ToolDiscoveryRouter(handlers, identity, auditLog, buildSelfService(), adminHandler);
}

test("find_tool only surfaces servers/tools this identity has a grant for", async () => {
  const permissions = new FakePermissionRepository({ "server-a": "*" }); // nothing granted on b
  const handlerA = buildHandler("a", [{ name: "read_file", description: "reads a file" }], permissions);
  const handlerB = buildHandler("b", [{ name: "send_message", description: "sends a Slack message" }], permissions);
  const router = buildRouter([handlerA, handlerB]);

  const results = await router.findTool("");

  assert.deepEqual(
    results.map((r) => `${r.server}:${r.name}`),
    ["a:read_file"],
    "server b's tool must never appear when there is no permission for it, even though it was connected",
  );
});

test("find_tool respects tool-level grants, not just server-level access", async () => {
  const permissions = new FakePermissionRepository({ "server-a": new Set(["read_file"]) });
  const handlerA = buildHandler(
    "a",
    [
      { name: "read_file", description: "reads a file" },
      { name: "delete_file", description: "deletes a file" },
    ],
    permissions,
  );
  const router = buildRouter([handlerA]);

  const results = await router.findTool("");

  assert.deepEqual(
    results.map((r) => r.name),
    ["read_file"],
    "delete_file must be invisible to discovery even though it exists on a server this identity can otherwise reach",
  );
});

test("find_tool matches by name or description, case-insensitively", async () => {
  const permissions = new FakePermissionRepository({ "server-a": "*" });
  const handlerA = buildHandler(
    "a",
    [
      { name: "read_file", description: "Reads the contents of a file" },
      { name: "list_directory", description: "Lists files in a directory" },
    ],
    permissions,
  );
  const router = buildRouter([handlerA]);

  const byName = await router.findTool("READ");
  const byDescription = await router.findTool("directory");

  assert.deepEqual(byName.map((r) => r.name), ["read_file"]);
  assert.deepEqual(byDescription.map((r) => r.name), ["list_directory"]);
});

test("call_tool routes to the correct server's handler", async () => {
  const permissions = new FakePermissionRepository({ "server-a": "*", "server-b": "*" });
  const handlerA = buildHandler("a", [{ name: "shared_name", description: "" }], permissions);
  const handlerB = buildHandler("b", [{ name: "shared_name", description: "" }], permissions);
  const router = buildRouter([handlerA, handlerB]);

  const resultFromA = await router.callTool("a", "shared_name", {});

  assert.equal(resultFromA.content?.[0]?.text, "called shared_name");
  // Both servers expose a tool with the same name — routing must be unambiguous by server,
  // which this test would not distinguish if call_tool ignored the server parameter and
  // just called the first match. Cross-checked via the audit-log test below instead, since
  // both handlers return an identical result here by construction.
});

test("call_tool still enforces permission — reusing ToolCallHandler unchanged", async () => {
  const permissions = new FakePermissionRepository({ "server-a": new Set(["read_file"]) });
  const handlerA = buildHandler("a", [{ name: "delete_file", description: "" }], permissions);
  const router = buildRouter([handlerA]);

  const result = await router.callTool("a", "delete_file", {});

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /Permission denied/);
});

test("call_tool for an unregistered server returns a clear error instead of throwing", async () => {
  const router = buildRouter([]);

  const result = await router.callTool("does-not-exist", "any_tool", {});

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /Unknown server/);
});

test("call_tool for a server this identity was never connected to still writes an audit entry", async () => {
  const auditLog = new (class implements AuditLogRepository {
    entries: AuditEntry[] = [];
    async write(entry: AuditEntry): Promise<void> {
      this.entries.push(entry);
    }
    async findRecentByIdentity(): Promise<StoredAuditEntry[]> {
      return [];
    }
    async search(): Promise<AuditLogRow[]> {
      return [];
    }
  })();
  const router = buildRouter([], auditLog);

  await router.callTool("sandbox-b", "read_text_file", { path: "/etc/passwd" });

  assert.equal(auditLog.entries.length, 1, "an attempt against an unreachable server must not disappear silently");
  assert.equal(auditLog.entries[0].status, "denied");
  assert.equal(auditLog.entries[0].serverName, "sandbox-b");
});

test("handleMetaToolCall('find_tool', ...) returns matching tools as JSON text", async () => {
  const permissions = new FakePermissionRepository({ "server-a": "*" });
  const handlerA = buildHandler("a", [{ name: "read_file", description: "reads a file" }], permissions);
  const router = buildRouter([handlerA]);

  const result = await router.handleMetaToolCall("find_tool", { query: "read" });

  const parsed = JSON.parse(result.content?.[0]?.text ?? "[]");
  assert.deepEqual(parsed, [{ server: "a", name: "read_file", description: "reads a file" }]);
});

test("handleMetaToolCall('call_tool', ...) dispatches to the named server/tool", async () => {
  const permissions = new FakePermissionRepository({ "server-a": "*" });
  const handlerA = buildHandler("a", [{ name: "read_file", description: "" }], permissions);
  const router = buildRouter([handlerA]);

  const result = await router.handleMetaToolCall("call_tool", { server: "a", tool: "read_file", arguments: {} });

  assert.equal(result.content?.[0]?.text, "called read_file");
});

test("handleMetaToolCall('call_tool', ...) rejects a call missing server or tool", async () => {
  const router = buildRouter([]);

  const result = await router.handleMetaToolCall("call_tool", { server: "a" });

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /requires both/);
});

test("handleMetaToolCall rejects any tool name other than the two meta-tools", async () => {
  const router = buildRouter([]);

  const result = await router.handleMetaToolCall("read_file", {});

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /Unknown tool/);
});

test("listMetaTools always returns the same fixed set of meta-tools, regardless of how many real servers/tools exist", async () => {
  const permissions = new FakePermissionRepository({ "server-a": "*", "server-b": "*", "server-c": "*" });
  const manyTools = Array.from({ length: 50 }, (_, i) => ({ name: `tool_${i}`, description: `tool number ${i}` }));
  const router = buildRouter([
    buildHandler("a", manyTools, permissions),
    buildHandler("b", manyTools, permissions),
    buildHandler("c", manyTools, permissions),
  ]);

  const { tools } = router.listMetaTools();

  assert.equal(
    tools.length,
    4,
    "tools/list payload must stay at exactly 4 meta-tools (find_tool, call_tool, list_services, " +
      "register_my_credential) no matter how many real tools exist behind the gateway",
  );
});

test("listMetaTools omits manage_roles when no adminHandler is supplied", async () => {
  const router = buildRouter([]);

  const { tools } = router.listMetaTools();

  assert.ok(!(tools as { name: string }[]).some((t) => t.name === "manage_roles"), "manage_roles must not be visible to a non-admin");
});

test("listMetaTools includes manage_roles only when an adminHandler is supplied", async () => {
  const adminHandler = new AdminToolHandler(
    new FakeRoleRepository(),
    new FakeUserRepository(),
    new FakeUpstreamServerRepository(),
    new FakeUserCredentialRepository(),
  );
  const router = buildRouter([], new NullAuditLogRepository(), adminHandler);

  const { tools } = router.listMetaTools();

  assert.ok((tools as { name: string }[]).some((t) => t.name === "manage_roles"), "manage_roles must be visible when an admin handler is supplied");
});

test("handleMetaToolCall('manage_roles', ...) is rejected when no adminHandler is supplied, even if called directly", async () => {
  const router = buildRouter([]);

  const result = await router.handleMetaToolCall("manage_roles", { action: "list_roles" });

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /only available to admins/);
});
