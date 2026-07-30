import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ServerResult } from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "../../config.js";
import { PostgresAuditLogRepository } from "../../adapters/postgres/AuditLogRepository.js";
import { PostgresIdentityRepository } from "../../adapters/postgres/IdentityRepository.js";
import { PostgresPermissionRepository } from "../../adapters/postgres/PermissionRepository.js";
import { createPool } from "../../adapters/postgres/pool.js";
import { PostgresRoleRepository } from "../../adapters/postgres/RoleRepository.js";
import { SafeAuditLogRepository } from "../../domain/SafeAuditLogRepository.js";
import { PostgresToolCatalogRepository } from "../../adapters/postgres/ToolCatalogRepository.js";
import { PostgresUpstreamServerRepository } from "../../adapters/postgres/UpstreamServerRepository.js";
import { PostgresUserCredentialRepository } from "../../adapters/postgres/UserCredentialRepository.js";
import { PostgresUserRepository } from "../../adapters/postgres/UserRepository.js";
import { AdminToolHandler } from "../../domain/AdminToolHandler.js";
import { buildAccessibleServerHandlers } from "../../domain/buildAccessibleServerHandlers.js";
import { SelfServiceHandler } from "../../domain/SelfServiceHandler.js";
import { ToolDiscoveryRouter } from "../../domain/ToolDiscoveryRouter.js";
import { PerSessionUpstreamConnectionProvider } from "../../adapters/mcp/UpstreamConnectionProvider.js";
import { LocalEmbedder } from "../../adapters/embeddings/LocalEmbedder.js";
import { hashApiKey } from "../../adapters/security/apiKeys.js";
import { AesGcmCredentialVault } from "../../adapters/security/CredentialVault.js";

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
  const roles = new PostgresRoleRepository(pool);
  const users = new PostgresUserRepository(pool);
  // Wrapped so a transient audit-write failure can never surface as if a real, possibly
  // already-completed tool call had failed (see SafeAuditLogRepository's docstring).
  const auditLog = new SafeAuditLogRepository(new PostgresAuditLogRepository(pool));
  const vault = new AesGcmCredentialVault(config.encryptionKey);
  const connectionProvider = new PerSessionUpstreamConnectionProvider(vault);
  const userCredentials = new PostgresUserCredentialRepository(pool);
  const toolCatalog = new PostgresToolCatalogRepository(pool);
  const embedder = new LocalEmbedder();

  const identity = await identities.findByApiKeyHash(hashApiKey(config.gatewayApiKey));
  if (!identity) {
    throw new Error("GATEWAY_API_KEY does not match any active identity.");
  }

  // Deliberately no "throw if this identity has zero permission grants" check anymore —
  // a brand-new user with no access yet still needs to be able to connect and use
  // list_services/register_my_credential to see what exists and configure themselves
  // once an admin grants their role access (see SelfServiceHandler's docstring).
  const accessibleServerIds = await permissions.findAccessibleServerIds(identity.userId);
  const accessibleServers = await upstreamServers.findManyByIds(accessibleServerIds);

  // Connects to nothing yet — each handler connects lazily on its own first real use
  // (find_tool's cache miss, or call_tool), see buildAccessibleServerHandlers's docstring
  // for why this replaced an eager connect-everything-up-front step.
  const { handlers, closeAll } = buildAccessibleServerHandlers(
    accessibleServers,
    identity,
    userCredentials,
    connectionProvider,
    permissions,
    auditLog,
  );
  const selfService = new SelfServiceHandler(identity.userId, permissions, upstreamServers, userCredentials, vault);
  const adminHandler = (await roles.isUserAdmin(identity.userId))
    ? new AdminToolHandler(roles, users, upstreamServers, userCredentials, connectionProvider, toolCatalog, embedder, identity)
    : undefined;
  const router = new ToolDiscoveryRouter(handlers, identity, auditLog, selfService, toolCatalog, embedder, adminHandler);

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

  const shutdown = (): void => {
    void closeAll().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error("[mcp-trust-gateway] fatal:", error);
  process.exit(1);
});
