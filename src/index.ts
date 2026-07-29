import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ServerResult } from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "./config.js";
import { PostgresAuditLogRepository } from "./db/AuditLogRepository.js";
import type { AuditLogRepository } from "./db/AuditLogRepository.js";
import { PostgresIdentityRepository } from "./db/IdentityRepository.js";
import { PostgresPermissionRepository } from "./db/PermissionRepository.js";
import type { PermissionRepository } from "./db/PermissionRepository.js";
import { createPool } from "./db/pool.js";
import { PostgresUpstreamServerRepository } from "./db/UpstreamServerRepository.js";
import type { Identity, UpstreamServer } from "./db/types.js";
import { ToolCallHandler } from "./gateway/ToolCallHandler.js";
import { ToolDiscoveryRouter } from "./gateway/ToolDiscoveryRouter.js";
import type { ToolCallResult } from "./gateway/UpstreamToolClient.js";
import { hashApiKey } from "./security/apiKeys.js";
import { CredentialVault } from "./security/vault.js";

/**
 * Composition root: wires concrete implementations together and starts the process.
 * No business logic lives here — see gateway/ToolCallHandler.ts and
 * gateway/ToolDiscoveryRouter.ts for that. This file's only job is "given real config,
 * build the real objects and connect them."
 *
 * Phase 2 scope (see DESIGN.md): the identity's accessible servers are derived from
 * PermissionRepository.findAccessibleServerIds(), not a single env var — one gateway
 * process connects to every server that identity has any grant on, and exposes exactly
 * two meta-tools (find_tool, call_tool) to the agent regardless of how many real tools sit
 * behind those servers.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  const identities = new PostgresIdentityRepository(pool);
  const upstreamServers = new PostgresUpstreamServerRepository(pool);
  const permissions = new PostgresPermissionRepository(pool);
  const auditLog = new PostgresAuditLogRepository(pool);
  const vault = new CredentialVault(config.encryptionKey);

  const identity = await identities.findByApiKeyHash(hashApiKey(config.gatewayApiKey));
  if (!identity) {
    throw new Error("GATEWAY_API_KEY does not match any active identity.");
  }

  const accessibleServerIds = await permissions.findAccessibleServerIds(identity.id);
  const accessibleServers = await upstreamServers.findManyByIds(accessibleServerIds);
  if (accessibleServers.length === 0) {
    throw new Error(`Identity "${identity.name}" has no permission grants on any upstream server.`);
  }

  const handlers = await Promise.all(
    accessibleServers.map((server) => connectServer(server, vault, identity, permissions, auditLog)),
  );
  const router = new ToolDiscoveryRouter(handlers, identity, auditLog);

  // ToolDiscoveryRouter/ToolCallHandler intentionally return the plain, minimal shapes
  // they need (see gateway/UpstreamToolClient.ts) rather than depending on the SDK's much
  // wider ServerResult union (which also covers unrelated request types like tasks). The
  // casts below are the one place that boundary is bridged — everything on their side of
  // it stays SDK-agnostic and easy to test.
  const server = new Server({ name: "mcp-trust-gateway", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => router.listMetaTools() as unknown as ServerResult);
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request) => (await router.handleMetaToolCall(request.params.name, request.params.arguments)) as ServerResult,
  );

  await server.connect(new StdioServerTransport());
}

/** Decrypts the credential (if any), spawns the real MCP server as a subprocess, and
 *  builds the ToolCallHandler that enforces permissions/audit for calls to it. */
async function connectServer(
  server: UpstreamServer,
  vault: CredentialVault,
  identity: Identity,
  permissions: PermissionRepository,
  auditLog: AuditLogRepository,
): Promise<ToolCallHandler> {
  const credential = server.credential ? vault.decrypt(server.credential) : undefined;

  const [command, ...args] = server.command.split(" ");
  const upstreamClient = new Client({ name: "mcp-trust-gateway", version: "0.1.0" });
  await upstreamClient.connect(
    new StdioClientTransport({
      command,
      args,
      env: credential ? { ...process.env, UPSTREAM_CREDENTIAL: credential } : undefined,
    }),
  );

  return new ToolCallHandler(identity, server, permissions, auditLog, {
    listTools: () => upstreamClient.listTools(),
    callTool: (name, callArgs) =>
      upstreamClient.callTool({ name, arguments: callArgs as Record<string, unknown> }) as Promise<ToolCallResult>,
  });
}

main().catch((error) => {
  console.error("[mcp-trust-gateway] fatal:", error);
  process.exit(1);
});
