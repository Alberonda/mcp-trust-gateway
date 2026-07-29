import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";

import type pg from "pg";
import { WebSocketServer } from "ws";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ServerResult } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";

import { PostgresAuditLogRepository } from "../../adapters/postgres/AuditLogRepository.js";
import type { AuditLogRepository } from "../../ports/AuditLogRepository.js";
import { PostgresIdentityRepository } from "../../adapters/postgres/IdentityRepository.js";
import type { IdentityRepository } from "../../ports/IdentityRepository.js";
import { PostgresPermissionRepository } from "../../adapters/postgres/PermissionRepository.js";
import type { PermissionRepository } from "../../ports/PermissionRepository.js";
import { createPool } from "../../adapters/postgres/pool.js";
import { PostgresRoleRepository } from "../../adapters/postgres/RoleRepository.js";
import type { RoleRepository } from "../../ports/RoleRepository.js";
import { SafeAuditLogRepository } from "../../domain/SafeAuditLogRepository.js";
import { PostgresSessionRepository } from "../../adapters/postgres/SessionRepository.js";
import type { SessionRepository } from "../../ports/SessionRepository.js";
import { PostgresUpstreamServerRepository } from "../../adapters/postgres/UpstreamServerRepository.js";
import type { UpstreamServerRepository } from "../../ports/UpstreamServerRepository.js";
import { PostgresUserCredentialRepository } from "../../adapters/postgres/UserCredentialRepository.js";
import type { UserCredentialRepository } from "../../ports/UserCredentialRepository.js";
import { PostgresUserRepository } from "../../adapters/postgres/UserRepository.js";
import type { UserRepository } from "../../ports/UserRepository.js";
import type { Identity } from "../../domain/types.js";
import { AdminToolHandler } from "../../domain/AdminToolHandler.js";
import { connectAccessibleServers } from "../../domain/connectAccessibleServers.js";
import { SelfServiceHandler } from "../../domain/SelfServiceHandler.js";
import { ToolCallHandler } from "../../domain/ToolCallHandler.js";
import { ToolDiscoveryRouter } from "../../domain/ToolDiscoveryRouter.js";
import { PerSessionUpstreamConnectionProvider } from "../../adapters/mcp/UpstreamConnectionProvider.js";
import type { ConnectedUpstream, UpstreamConnectionProvider } from "../../ports/UpstreamConnectionProvider.js";
import { AesGcmCredentialVault } from "../../adapters/security/CredentialVault.js";
import type { CredentialVault } from "../../ports/CredentialVault.js";
import { InMemoryRelayAgentRegistry } from "../../adapters/relay/InMemoryRelayAgentRegistry.js";
import { RelayUpstreamConnectionProvider } from "../../adapters/relay/RelayUpstreamConnectionProvider.js";
import { RoutingUpstreamConnectionProvider } from "../../adapters/relay/RoutingUpstreamConnectionProvider.js";
import { resolveIdentityFromAuthHeader, resolveIdentityFromSessionToken } from "./auth.js";
import { HttpStatusError } from "./HttpStatusError.js";
import type { HttpGatewayConfig } from "./httpConfig.js";
import { loadHttpConfig } from "./httpConfig.js";
import { InMemoryTokenBucketRateLimiter } from "../../adapters/http/RateLimiter.js";
import type { RateLimiter } from "../../ports/RateLimiter.js";

/**
 * Composition root for **HTTP mode**: one persistent, centrally-hosted process that many
 * different identities connect to concurrently over the network, instead of one process
 * per identity spawned locally (see src/index.ts, stdio mode's composition root).
 *
 * This is what resolves the deployment-centralization gap in DESIGN.md's "Open
 * architectural gaps": only *this* process needs direct Postgres credentials — team
 * members' machines only need network access to whatever host runs this, never to the
 * database itself.
 *
 * Auth (Phase 3b): POST /login exchanges a long-lived API key for a short-lived session
 * token (SessionRepository) — every other route (/mcp) authenticates via that session
 * token instead, so the long-lived credential itself is transmitted as rarely as possible.
 */

/** One live MCP protocol connection — not to be confused with a login session record
 *  (db/SessionRepository.ts's Session), which is the short-lived *credential* used to
 *  authenticate the request that creates one of these. */
interface McpSession {
  readonly transport: StreamableHTTPServerTransport;
  readonly identityId: string;
  readonly connectedUpstreams: readonly ConnectedUpstream[];
}

interface Dependencies {
  readonly pool: pg.Pool;
  readonly identities: IdentityRepository;
  readonly permissions: PermissionRepository;
  readonly upstreamServers: UpstreamServerRepository;
  readonly auditLog: AuditLogRepository;
  readonly sessions: SessionRepository;
  readonly connectionProvider: UpstreamConnectionProvider;
  readonly userCredentials: UserCredentialRepository;
  readonly roles: RoleRepository;
  readonly users: UserRepository;
  readonly vault: CredentialVault;
  readonly rateLimiter: RateLimiter;
  readonly sessionTtlMinutes: number;
}

async function createMcpSession(identity: Identity, deps: Dependencies): Promise<McpSession> {
  // Deliberately no "throw if this identity has zero permission grants" check anymore —
  // a brand-new user with no access yet still needs to be able to connect and use
  // list_services/register_my_credential to see what exists and configure themselves
  // once an admin grants their role access (see SelfServiceHandler's docstring).
  const accessibleServerIds = await deps.permissions.findAccessibleServerIds(identity.userId);
  const accessibleServers = await deps.upstreamServers.findManyByIds(accessibleServerIds);

  // Isolated per server — one misconfigured server (e.g. missing credentials) must never
  // prevent connecting to every OTHER accessible server too (see
  // gateway/connectAccessibleServers.ts's docstring for the real incident that found this).
  const connectedServers = await connectAccessibleServers(accessibleServers, identity.userId, deps.userCredentials, deps.connectionProvider);
  const connectedUpstreams = connectedServers.map(({ connected }) => connected);
  const handlers = connectedServers.map(
    ({ server, connected: { client } }) => new ToolCallHandler(identity, server, deps.permissions, deps.auditLog, client),
  );
  const selfService = new SelfServiceHandler(identity.userId, deps.permissions, deps.upstreamServers, deps.userCredentials, deps.vault);
  const adminHandler = (await deps.roles.isUserAdmin(identity.userId))
    ? new AdminToolHandler(deps.roles, deps.users, deps.upstreamServers, deps.userCredentials)
    : undefined;
  const router = new ToolDiscoveryRouter(handlers, identity, deps.auditLog, selfService, adminHandler);

  const mcpServer = new Server({ name: "mcp-trust-gateway", version: "0.1.0" }, { capabilities: { tools: {} } });
  mcpServer.setRequestHandler(ListToolsRequestSchema, () => router.listMetaTools() as unknown as ServerResult);
  mcpServer.setRequestHandler(
    CallToolRequestSchema,
    async (request) => (await router.handleMetaToolCall(request.params.name, request.params.arguments)) as ServerResult,
  );

  let mcpSession: McpSession;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      mcpSessions.set(sessionId, mcpSession);
    },
  });
  mcpSession = { transport, identityId: identity.id, connectedUpstreams };

  transport.onclose = () => {
    const sessionId = transport.sessionId;
    if (sessionId) mcpSessions.delete(sessionId);
    Promise.all(connectedUpstreams.map((upstream) => upstream.close())).catch((error: unknown) => {
      console.error("[mcp-trust-gateway:http] Error closing upstream connections for a closed session:", error);
    });
  };

  await mcpServer.connect(transport);
  return mcpSession;
}

// Module-level MCP-protocol-session store — one per running process, cleared entry-by-entry
// as sessions close (see transport.onclose above) and entirely on graceful shutdown. Not to
// be confused with login sessions (db/SessionRepository.ts), which persist in Postgres.
const mcpSessions = new Map<string, McpSession>();

function mcpSessionIdFrom(req: Request): string | undefined {
  const header = req.headers["mcp-session-id"];
  return typeof header === "string" ? header : undefined;
}

/** Deliberately unauthenticated and unfiltered by rate limiting — this is what a load
 *  balancer/uptime monitor polls to decide whether to route traffic here at all, so it
 *  can't depend on a session existing yet. Confirms the process can actually reach
 *  Postgres, not just that the HTTP server itself is accepting connections — a gateway
 *  that's up but can't reach its database is not meaningfully healthy. */
async function handleHealth(_req: Request, res: Response, deps: Dependencies): Promise<void> {
  try {
    await deps.pool.query("SELECT 1");
    res.status(200).json({ status: "ok" });
  } catch (error) {
    console.error("[mcp-trust-gateway:http] Health check failed to reach Postgres:", error);
    res.status(503).json({ status: "unhealthy" });
  }
}

async function handleLogin(req: Request, res: Response, deps: Dependencies): Promise<void> {
  const authResult = await resolveIdentityFromAuthHeader(req.headers.authorization, deps.identities);
  if ("error" in authResult) {
    res.status(401).json({ error: authResult.error });
    return;
  }

  const { token, expiresAt } = await deps.sessions.create(
    authResult.identity.userId,
    authResult.identity.id,
    deps.sessionTtlMinutes,
  );
  res.status(200).json({ token, expiresAt: expiresAt.toISOString() });
}

async function handleLogout(req: Request, res: Response, deps: Dependencies): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : undefined;
  if (token) await deps.sessions.revoke(token);
  res.status(204).end();
}

async function handleMcpPost(req: Request, res: Response, deps: Dependencies): Promise<void> {
  const authResult = await resolveIdentityFromSessionToken(req.headers.authorization, deps.sessions, deps.identities);
  if ("error" in authResult) {
    res.status(401).json({ error: authResult.error });
    return;
  }
  const { identity } = authResult;

  if (!deps.rateLimiter.tryConsume(identity.id)) {
    res.status(429).json({ error: "Rate limit exceeded. Please slow down." });
    return;
  }

  const mcpSessionId = mcpSessionIdFrom(req);
  const existing = mcpSessionId ? mcpSessions.get(mcpSessionId) : undefined;

  if (existing && existing.identityId !== identity.id) {
    res.status(403).json({ error: "This session belongs to a different identity." });
    return;
  }

  if (existing) {
    await existing.transport.handleRequest(req, res, req.body);
    return;
  }

  if (!isInitializeRequest(req.body)) {
    res.status(400).json({ error: "No active session for this request, and it is not an initialize request." });
    return;
  }

  const mcpSession = await createMcpSession(identity, deps);
  await mcpSession.transport.handleRequest(req, res, req.body);
}

async function handleMcpGetOrDelete(req: Request, res: Response, deps: Dependencies): Promise<void> {
  const authResult = await resolveIdentityFromSessionToken(req.headers.authorization, deps.sessions, deps.identities);
  if ("error" in authResult) {
    res.status(401).json({ error: authResult.error });
    return;
  }

  const mcpSessionId = mcpSessionIdFrom(req);
  const mcpSession = mcpSessionId ? mcpSessions.get(mcpSessionId) : undefined;
  if (!mcpSession || mcpSession.identityId !== authResult.identity.id) {
    res.status(400).json({ error: "Invalid or missing session for this identity." });
    return;
  }

  await mcpSession.transport.handleRequest(req, res);
}

/** Wraps a handler so any thrown/rejected error becomes a clean JSON HTTP response
 *  instead of an unhandled rejection that could crash the whole shared process over one
 *  bad request from one identity. */
function safely(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      console.error("[mcp-trust-gateway:http] Unhandled request error:", error);
      if (res.headersSent) return;
      if (error instanceof HttpStatusError) {
        res.status(error.statusCode).json({ error: error.message });
      } else {
        res.status(500).json({ error: "Internal server error." });
      }
    }
  };
}

/** Exposed alongside Dependencies (not part of it) because it needs one extra method
 *  (registerAgent) beyond the RelayAgentRegistry port that RoutingUpstreamConnectionProvider
 *  depends on — only main()'s WebSocket upgrade handling needs that extra method, not any
 *  domain code. */
function buildDependencies(config: HttpGatewayConfig): { deps: Dependencies; relayAgentRegistry: InMemoryRelayAgentRegistry } {
  const pool = createPool(config.databaseUrl);
  const vault = new AesGcmCredentialVault(config.encryptionKey);
  const relayAgentRegistry = new InMemoryRelayAgentRegistry();
  const connectionProvider = new RoutingUpstreamConnectionProvider(
    new PerSessionUpstreamConnectionProvider(vault),
    new RelayUpstreamConnectionProvider(relayAgentRegistry, vault),
  );
  const deps: Dependencies = {
    pool,
    identities: new PostgresIdentityRepository(pool),
    permissions: new PostgresPermissionRepository(pool),
    upstreamServers: new PostgresUpstreamServerRepository(pool),
    userCredentials: new PostgresUserCredentialRepository(pool),
    roles: new PostgresRoleRepository(pool),
    users: new PostgresUserRepository(pool),
    vault,
    auditLog: new SafeAuditLogRepository(new PostgresAuditLogRepository(pool)),
    sessions: new PostgresSessionRepository(pool),
    connectionProvider,
    rateLimiter: new InMemoryTokenBucketRateLimiter(config.rateLimit.maxTokens, config.rateLimit.refillPerSecond / 1000),
    sessionTtlMinutes: config.sessionTtlMinutes,
  };
  return { deps, relayAgentRegistry };
}

/** Verifies the relay agent's Authorization header the same way any other request does
 *  (see auth.ts) — a relay agent is just a client holding a real API key, not a separate
 *  auth scheme. Rejects and closes the socket if the header is missing or the key is
 *  unknown/inactive, before ever calling registerAgent. */
async function handleAgentUpgrade(
  req: http.IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
  wss: WebSocketServer,
  deps: Dependencies,
  relayAgentRegistry: InMemoryRelayAgentRegistry,
): Promise<void> {
  const authResult = await resolveIdentityFromAuthHeader(req.headers.authorization, deps.identities);
  if ("error" in authResult) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    console.log(`[mcp-trust-gateway:http] Relay agent connected (identity "${authResult.identity.name}").`);
    relayAgentRegistry.registerAgent({
      send: (data) => ws.send(data),
      onMessage: (handler) => ws.on("message", (data) => handler(data.toString())),
      onClose: (handler) => ws.on("close", handler),
    });
  });
}

async function main(): Promise<void> {
  const config = loadHttpConfig();
  const { deps, relayAgentRegistry } = buildDependencies(config);

  const app = createMcpExpressApp({ host: config.host, allowedHosts: config.allowedHosts as string[] | undefined });
  app.get("/health", safely((req, res) => handleHealth(req, res, deps)));
  app.post("/login", safely((req, res) => handleLogin(req, res, deps)));
  app.post("/logout", safely((req, res) => handleLogout(req, res, deps)));
  app.post("/mcp", safely((req, res) => handleMcpPost(req, res, deps)));
  app.get("/mcp", safely((req, res) => handleMcpGetOrDelete(req, res, deps)));
  app.delete("/mcp", safely((req, res) => handleMcpGetOrDelete(req, res, deps)));

  const server = config.tls
    ? https.createServer({ cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath) }, app)
    : http.createServer(app);

  // noServer: true — we own the upgrade ourselves (see handleAgentUpgrade) so we can
  // authenticate BEFORE completing the handshake, and so /mcp's own traffic (which never
  // upgrades) is unaffected.
  const agentWss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/agent") {
      void handleAgentUpgrade(req, socket, head, agentWss, deps, relayAgentRegistry);
    } else {
      socket.destroy();
    }
  });

  if (!config.tls) {
    console.warn(
      "[mcp-trust-gateway:http] Running without TLS. Set HTTP_TLS_CERT_PATH/HTTP_TLS_KEY_PATH, " +
        "or terminate TLS at a reverse proxy in front of this process, before exposing it beyond localhost.",
    );
  }

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  console.log(`[mcp-trust-gateway:http] Listening on ${config.tls ? "https" : "http"}://${config.host}:${config.port}/mcp`);

  const shutdown = async (): Promise<void> => {
    console.log("[mcp-trust-gateway:http] Shutting down, closing all active sessions...");
    await Promise.all(
      [...mcpSessions.values()].map(async (mcpSession) => {
        await mcpSession.transport.close();
        await Promise.all(mcpSession.connectedUpstreams.map((upstream) => upstream.close()));
      }),
    );
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // Last-resort safety net for a long-lived, multi-tenant process: log instead of
  // crashing the whole service over a bug triggered by one identity's request. Every
  // request handler above already has its own try/catch (see safely()) — this only
  // catches what slips past that, e.g. an error in code outside a request's lifecycle.
  process.on("uncaughtException", (error) => console.error("[mcp-trust-gateway:http] Uncaught exception:", error));
  process.on("unhandledRejection", (reason) => console.error("[mcp-trust-gateway:http] Unhandled rejection:", reason));
}

main().catch((error) => {
  console.error("[mcp-trust-gateway:http] Fatal startup error:", error);
  process.exit(1);
});
