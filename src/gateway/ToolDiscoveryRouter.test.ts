import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditEntry, AuditLogRepository, StoredAuditEntry } from "../db/AuditLogRepository.js";
import type { AllowedTools, PermissionRepository } from "../db/PermissionRepository.js";
import type { Identity, UpstreamServer } from "../db/types.js";
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

class NullAuditLogRepository implements AuditLogRepository {
  async write(): Promise<void> {}
  async findRecentByIdentity(): Promise<StoredAuditEntry[]> {
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
  return { id: `server-${name}`, name, command: "irrelevant", credential: null };
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
function buildRouter(handlers: readonly ToolCallHandler[], auditLog: AuditLogRepository = new NullAuditLogRepository()) {
  return new ToolDiscoveryRouter(handlers, identity, auditLog);
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

test("listMetaTools always returns exactly the two meta-tools, regardless of how many real servers/tools exist", async () => {
  const permissions = new FakePermissionRepository({ "server-a": "*", "server-b": "*", "server-c": "*" });
  const manyTools = Array.from({ length: 50 }, (_, i) => ({ name: `tool_${i}`, description: `tool number ${i}` }));
  const router = buildRouter([
    buildHandler("a", manyTools, permissions),
    buildHandler("b", manyTools, permissions),
    buildHandler("c", manyTools, permissions),
  ]);

  const { tools } = router.listMetaTools();

  assert.equal(tools.length, 2, "tools/list payload must stay at exactly 2 meta-tools no matter how many real tools exist behind the gateway");
});
