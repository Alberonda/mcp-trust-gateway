import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ServerResult } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";

import { PostgresAuditLogRepository } from "../db/AuditLogRepository.js";
import type { AuditLogRepository } from "../db/AuditLogRepository.js";
import { PostgresIdentityRepository } from "../db/IdentityRepository.js";
import type { IdentityRepository } from "../db/IdentityRepository.js";
import { PostgresPermissionRepository } from "../db/PermissionRepository.js";
import type { PermissionRepository } from "../db/PermissionRepository.js";
import { createPool } from "../db/pool.js";
import { SafeAuditLogRepository } from "../db/SafeAuditLogRepository.js";
import { PostgresSessionRepository } from "../db/SessionRepository.js";
import type { SessionRepository } from "../db/SessionRepository.js";
import { PostgresUpstreamServerRepository } from "../db/UpstreamServerRepository.js";
import type { UpstreamServerRepository } from "../db/UpstreamServerRepository.js";
import type { Identity } from "../db/types.js";
import { ToolCallHandler } from "../gateway/ToolCallHandler.js";
import { ToolDiscoveryRouter } from "../gateway/ToolDiscoveryRouter.js";
import { PerSessionUpstreamConnectionProvider } from "../gateway/UpstreamConnectionProvider.js";
import type { ConnectedUpstream, UpstreamConnectionProvider } from "../gateway/UpstreamConnectionProvider.js";
import { CredentialVault } from "../security/vault.js";
import { resolveIdentityFromAuthHeader, resolveIdentityFromSessionToken } from "./auth.js";
import { HttpStatusError } from "./HttpStatusError.js";
import type { HttpGatewayConfig } from "./httpConfig.js";
import { loadHttpConfig } from "./httpConfig.js";
import { InMemoryTokenBucketRateLimiter } from "./RateLimiter.js";
import type { RateLimiter } from "./RateLimiter.js";

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
  readonly identities: IdentityRepository;
  readonly permissions: PermissionRepository;
  readonly upstreamServers: UpstreamServerRepository;
  readonly auditLog: AuditLogRepository;
  readonly sessions: SessionRepository;
  readonly connectionProvider: UpstreamConnectionProvider;
  readonly rateLimiter: RateLimiter;
  readonly sessionTtlMinutes: number;
}

async function createMcpSession(identity: Identity, deps: Dependencies): Promise<McpSession> {
  const accessibleServerIds = await deps.permissions.findAccessibleServerIds(identity.userId);
  const accessibleServers = await deps.upstreamServers.findManyByIds(accessibleServerIds);
  if (accessibleServers.length === 0) {
    throw new HttpStatusError(403, `Identity "${identity.name}" has no permission grants on any upstream server.`);
  }

  const connectedUpstreams = await Promise.all(accessibleServers.map((server) => deps.connectionProvider.connect(server)));
  const handlers = connectedUpstreams.map(
    ({ client }, i) => new ToolCallHandler(identity, accessibleServers[i], deps.permissions, deps.auditLog, client),
  );
  const router = new ToolDiscoveryRouter(handlers, identity, deps.auditLog);

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

function buildDependencies(config: HttpGatewayConfig): Dependencies {
  const pool = createPool(config.databaseUrl);
  return {
    identities: new PostgresIdentityRepository(pool),
    permissions: new PostgresPermissionRepository(pool),
    upstreamServers: new PostgresUpstreamServerRepository(pool),
    auditLog: new SafeAuditLogRepository(new PostgresAuditLogRepository(pool)),
    sessions: new PostgresSessionRepository(pool),
    connectionProvider: new PerSessionUpstreamConnectionProvider(new CredentialVault(config.encryptionKey)),
    rateLimiter: new InMemoryTokenBucketRateLimiter(config.rateLimit.maxTokens, config.rateLimit.refillPerSecond / 1000),
    sessionTtlMinutes: config.sessionTtlMinutes,
  };
}

async function main(): Promise<void> {
  const config = loadHttpConfig();
  const deps = buildDependencies(config);

  const app = createMcpExpressApp({ host: config.host, allowedHosts: config.allowedHosts as string[] | undefined });
  app.post("/login", safely((req, res) => handleLogin(req, res, deps)));
  app.post("/logout", safely((req, res) => handleLogout(req, res, deps)));
  app.post("/mcp", safely((req, res) => handleMcpPost(req, res, deps)));
  app.get("/mcp", safely((req, res) => handleMcpGetOrDelete(req, res, deps)));
  app.delete("/mcp", safely((req, res) => handleMcpGetOrDelete(req, res, deps)));

  const server = config.tls
    ? https.createServer({ cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath) }, app)
    : http.createServer(app);

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
