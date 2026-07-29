import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditStatus } from "../constants.js";
import type { AuditEntry, AuditLogRepository, AuditLogRow, StoredAuditEntry } from "../db/AuditLogRepository.js";
import type { AllowedTools, PermissionRepository } from "../db/PermissionRepository.js";
import type { Identity, UpstreamServer } from "../db/types.js";
import { REDACTED_PLACEHOLDER } from "../constants.js";
import { SafeAuditLogRepository } from "../db/SafeAuditLogRepository.js";
import { ToolCallHandler } from "./ToolCallHandler.js";
import type { ToolCallResult, UpstreamToolClient } from "./UpstreamToolClient.js";

/**
 * In-memory fakes — no Postgres, no MCP subprocess, no network. This is the whole payoff
 * of injecting interfaces instead of concrete Postgres/SDK classes into ToolCallHandler.
 */

class FakePermissionRepository implements PermissionRepository {
  constructor(private readonly allowed: boolean) {}
  async isCallAllowed(): Promise<boolean> {
    return this.allowed;
  }
  async findAccessibleServerIds(): Promise<string[]> {
    return [];
  }
  async findAllowedToolNames(): Promise<AllowedTools> {
    return this.allowed ? "all" : new Set();
  }
}

class FakeAuditLogRepository implements AuditLogRepository {
  readonly entries: AuditEntry[] = [];
  async write(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
  async findRecentByIdentity(identityId: string, limit: number): Promise<StoredAuditEntry[]> {
    return this.entries
      .filter((entry) => entry.identityId === identityId)
      .slice(0, limit)
      .map((entry, index) => ({ ...entry, id: index, createdAt: new Date() }));
  }
  async search(): Promise<AuditLogRow[]> {
    return [];
  }
}

class FakeUpstreamToolClient implements UpstreamToolClient {
  callToolInvocations: Array<{ name: string; args: unknown }> = [];

  constructor(
    private readonly result: ToolCallResult = { content: [{ type: "text", text: "ok" }] },
    private readonly error?: Error,
  ) {}

  async listTools(): Promise<unknown> {
    return { tools: [{ name: "some-tool" }] };
  }

  async callTool(name: string, args: unknown): Promise<ToolCallResult> {
    this.callToolInvocations.push({ name, args });
    if (this.error) throw this.error;
    return this.result;
  }
}

const testIdentity: Identity = {
  id: "identity-1",
  userId: "user-1",
  name: "test-identity",
  apiKeyHash: "irrelevant",
  isActive: true,
};
const testServer: UpstreamServer = { id: "server-1", name: "test-server", command: "irrelevant", args: [] };

function buildHandler(options: {
  allowed?: boolean;
  upstreamClient?: FakeUpstreamToolClient;
  auditLog?: FakeAuditLogRepository;
  clock?: () => number;
}) {
  const auditLog = options.auditLog ?? new FakeAuditLogRepository();
  const upstreamClient = options.upstreamClient ?? new FakeUpstreamToolClient();
  const handler = new ToolCallHandler(
    testIdentity,
    testServer,
    new FakePermissionRepository(options.allowed ?? true),
    auditLog,
    upstreamClient,
    options.clock,
  );
  return { handler, auditLog, upstreamClient };
}

test("listTools delegates directly to the upstream client", async () => {
  const { handler } = buildHandler({});

  assert.deepEqual(await handler.listTools(), { tools: [{ name: "some-tool" }] });
});

test("an allowed, successful call forwards to upstream and logs allowed_success", async () => {
  const { handler, auditLog, upstreamClient } = buildHandler({ allowed: true });

  const result = await handler.callTool("read_file", { path: "/tmp/x" });

  assert.deepEqual(result, { content: [{ type: "text", text: "ok" }] });
  assert.deepEqual(upstreamClient.callToolInvocations, [{ name: "read_file", args: { path: "/tmp/x" } }]);
  assert.equal(auditLog.entries.length, 1);
  assert.equal(auditLog.entries[0].status, AuditStatus.AllowedSuccess);
});

test("an allowed call whose result is itself an error logs allowed_failure, not allowed_success", async () => {
  const upstreamClient = new FakeUpstreamToolClient({ isError: true, content: [{ type: "text", text: "boom" }] });
  const { handler, auditLog } = buildHandler({ allowed: true, upstreamClient });

  await handler.callTool("read_file", {});

  assert.equal(auditLog.entries[0].status, AuditStatus.AllowedFailure);
});

test("a denied call never reaches the upstream client", async () => {
  const { handler, upstreamClient } = buildHandler({ allowed: false });

  await handler.callTool("delete_everything", {});

  assert.equal(upstreamClient.callToolInvocations.length, 0, "upstream must not be called when permission is denied");
});

test("a denied call logs 'denied' and returns a clear, non-throwing MCP error result", async () => {
  const { handler, auditLog } = buildHandler({ allowed: false });

  const result = await handler.callTool("delete_everything", {});

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /Permission denied/);
  assert.equal(auditLog.entries[0].status, AuditStatus.Denied);
});

test("params are redacted before being written to the audit log", async () => {
  const { handler, auditLog } = buildHandler({ allowed: true });

  await handler.callTool("call_api", { apiKey: "super-secret", path: "/ok" });

  assert.deepEqual(auditLog.entries[0].paramsRedacted, { apiKey: REDACTED_PLACEHOLDER, path: "/ok" });
});

test("params are redacted the same way even when the call is denied", async () => {
  const { handler, auditLog } = buildHandler({ allowed: false });

  await handler.callTool("call_api", { password: "hunter2" });

  assert.deepEqual(auditLog.entries[0].paramsRedacted, { password: REDACTED_PLACEHOLDER });
});

test("an upstream error is logged as allowed_failure and rethrown to the caller", async () => {
  const upstreamError = new Error("upstream exploded");
  const upstreamClient = new FakeUpstreamToolClient(undefined, upstreamError);
  const { handler, auditLog } = buildHandler({ allowed: true, upstreamClient });

  await assert.rejects(() => handler.callTool("flaky_tool", {}), upstreamError);
  assert.equal(auditLog.entries[0].status, AuditStatus.AllowedFailure);
  assert.equal(auditLog.entries[0].resultSummary, "upstream exploded");
});

test("duration_ms reflects the injected clock, not wall-clock timing", async () => {
  const timestamps = [1_000, 1_250];
  const clock = () => timestamps.shift()!;
  const { handler, auditLog } = buildHandler({ allowed: true, clock });

  await handler.callTool("read_file", {});

  assert.equal(auditLog.entries[0].durationMs, 250);
});

// Regression test for the bug documented in DESIGN.md's "Open architectural gaps" section:
// a successful upstream call must never be reported as a failure just because writing its
// audit entry afterwards failed. Wrapping the audit log in SafeAuditLogRepository (the
// actual fix) is what makes this pass — without it, this test fails exactly the way the
// real bug did: the successful result never reaches the caller.
test("a successful call still returns its real result even if writing the audit entry fails", async () => {
  const throwingAuditLog: AuditLogRepository = {
    write: async () => {
      throw new Error("Postgres is unreachable");
    },
    findRecentByIdentity: async () => [],
    search: async () => [],
  };
  const safeAuditLog = new SafeAuditLogRepository(throwingAuditLog, () => {});
  const upstreamClient = new FakeUpstreamToolClient({ content: [{ type: "text", text: "the real result" }] });
  const handler = new ToolCallHandler(
    testIdentity,
    testServer,
    new FakePermissionRepository(true),
    safeAuditLog,
    upstreamClient,
  );

  const result = await handler.callTool("read_file", {});

  assert.deepEqual(result, { content: [{ type: "text", text: "the real result" }] });
});
