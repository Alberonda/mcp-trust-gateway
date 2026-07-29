import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ServerResult } from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "./config.js";
import { PostgresAuditLogRepository } from "./db/AuditLogRepository.js";
import { PostgresIdentityRepository } from "./db/IdentityRepository.js";
import { PostgresPermissionRepository } from "./db/PermissionRepository.js";
import { createPool } from "./db/pool.js";
import { PostgresUpstreamServerRepository } from "./db/UpstreamServerRepository.js";
import { ToolCallHandler } from "./gateway/ToolCallHandler.js";
import type { ToolCallResult } from "./gateway/UpstreamToolClient.js";
import { hashApiKey } from "./security/apiKeys.js";
import { CredentialVault } from "./security/vault.js";

/**
 * Composition root: wires concrete implementations together and starts the process.
 * No business logic lives here — see gateway/ToolCallHandler.ts for that. This file's
 * only job is "given real config, build the real objects and connect them."
 *
 * Phase 1 scope: one gateway process proxies to exactly one upstream MCP server, for one
 * identity, authenticated via an environment variable — the natural fit for how MCP
 * clients launch local stdio servers (see README.md's client config example). Multi-server
 * routing and per-user session tokens are Phase 2 (see DESIGN.md).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  const identities = new PostgresIdentityRepository(pool);
  const upstreamServers = new PostgresUpstreamServerRepository(pool);
  const permissions = new PostgresPermissionRepository(pool);
  const auditLog = new PostgresAuditLogRepository(pool);

  const identity = await identities.findByApiKeyHash(hashApiKey(config.gatewayApiKey));
  if (!identity) {
    throw new Error("GATEWAY_API_KEY does not match any active identity.");
  }

  const upstreamServer = await upstreamServers.findByName(config.upstreamServerName);
  if (!upstreamServer) {
    throw new Error(`No upstream server registered as "${config.upstreamServerName}".`);
  }

  const vault = new CredentialVault(config.encryptionKey);
  const upstreamCredential = upstreamServer.credential ? vault.decrypt(upstreamServer.credential) : undefined;

  const [command, ...args] = upstreamServer.command.split(" ");
  const upstreamClient = new Client({ name: "mcp-trust-gateway", version: "0.1.0" });
  await upstreamClient.connect(
    new StdioClientTransport({
      command,
      args,
      env: upstreamCredential ? { ...process.env, UPSTREAM_CREDENTIAL: upstreamCredential } : undefined,
    }),
  );

  // Adapter from the SDK's Client to our own minimal UpstreamToolClient interface (see
  // gateway/UpstreamToolClient.ts) — the cast is the SDK-facing half of the same boundary
  // bridged again below when handing results back to the SDK's Server.
  const handler = new ToolCallHandler(identity, upstreamServer, permissions, auditLog, {
    listTools: () => upstreamClient.listTools(),
    callTool: (name, callArgs) =>
      upstreamClient.callTool({ name, arguments: callArgs as Record<string, unknown> }) as Promise<ToolCallResult>,
  });

  // ToolCallHandler intentionally returns the plain, minimal shape it needs (see
  // gateway/UpstreamToolClient.ts) rather than depending on the SDK's much wider
  // ServerResult union (which also covers unrelated request types like tasks). The two
  // casts below are the one place that boundary is bridged — everything on the
  // ToolCallHandler side of it stays SDK-agnostic and easy to test.
  const server = new Server({ name: "mcp-trust-gateway", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => (await handler.listTools()) as ServerResult);
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request) => (await handler.callTool(request.params.name, request.params.arguments)) as ServerResult,
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error("[mcp-trust-gateway] fatal:", error);
  process.exit(1);
});
