import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ServerResult } from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "./config.js";
import { PostgresAuditLogRepository } from "./db/AuditLogRepository.js";
import { PostgresIdentityRepository } from "./db/IdentityRepository.js";
import { PostgresPermissionRepository } from "./db/PermissionRepository.js";
import { createPool } from "./db/pool.js";
import { SafeAuditLogRepository } from "./db/SafeAuditLogRepository.js";
import { PostgresUpstreamServerRepository } from "./db/UpstreamServerRepository.js";
import { ToolCallHandler } from "./gateway/ToolCallHandler.js";
import { ToolDiscoveryRouter } from "./gateway/ToolDiscoveryRouter.js";
import { PerSessionUpstreamConnectionProvider } from "./gateway/UpstreamConnectionProvider.js";
import { hashApiKey } from "./security/apiKeys.js";
import { CredentialVault } from "./security/vault.js";

/**
 * Composition root for **stdio mode**: one process, one identity (from a single
 * GATEWAY_API_KEY env var, resolved once at startup), spawned locally by an MCP client
 * (Devin CLI, Claude Desktop). Simplest option for solo use.
 *
 * For team use with centrally-managed permissions/audit, see httpServer.ts instead — a
 * second entry point that runs as one persistent, centrally-hosted service reachable by
 * many identities over the network, resolving identity per-connection rather than once at
 * boot. See DESIGN.md's Phase 2.5 for why both modes exist rather than replacing this one.
 *
 * No business logic lives here — see gateway/ToolCallHandler.ts and
 * gateway/ToolDiscoveryRouter.ts for that. This file's only job is "given real config,
 * build the real objects and connect them."
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  const identities = new PostgresIdentityRepository(pool);
  const upstreamServers = new PostgresUpstreamServerRepository(pool);
  const permissions = new PostgresPermissionRepository(pool);
  // Wrapped so a transient audit-write failure can never surface as if a real, possibly
  // already-completed tool call had failed (see SafeAuditLogRepository's docstring).
  const auditLog = new SafeAuditLogRepository(new PostgresAuditLogRepository(pool));
  const connectionProvider = new PerSessionUpstreamConnectionProvider(new CredentialVault(config.encryptionKey));

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
    accessibleServers.map(async (server) => {
      const { client } = await connectionProvider.connect(server);
      return new ToolCallHandler(identity, server, permissions, auditLog, client);
    }),
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

main().catch((error) => {
  console.error("[mcp-trust-gateway] fatal:", error);
  process.exit(1);
});
