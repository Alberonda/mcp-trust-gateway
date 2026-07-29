import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ServerResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * A thin stdio-to-HTTP relay for mcp-trust-gateway's HTTP mode. Holds exactly one secret
 * locally -- GATEWAY_API_KEY, a narrow, revocable credential -- and never the database
 * URL or master encryption key, which stay exclusively on whatever server runs
 * entrypoints/http/httpServer.ts. This process has zero business logic of its own: no
 * permission checks, no decryption, nothing an attacker with this process's memory could
 * use to reach any OTHER user's data. It only knows how to log in, keep a short-lived
 * session token fresh, and forward tools/list and tools/call verbatim.
 *
 * MCP clients that support remote HTTP servers directly (with a static Authorization
 * header) don't need this at all -- see the main README's "Connecting without a local
 * process" section. This exists for clients that only support stdio servers, or for
 * anyone who'd rather not send a long-lived API key on every single request (see
 * DESIGN.md for why session tokens exist).
 */

interface Session {
  readonly token: string;
  readonly expiresAt: Date;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

const apiKey = requireEnv("GATEWAY_API_KEY");
const gatewayUrl = process.env.GATEWAY_URL ?? "https://mcp-trust-gateway.onrender.com";

let session: Session | undefined;

/** Logs in again whenever the current session is missing or within 5 minutes of
 *  expiring -- refreshing proactively instead of waiting for a 401, so a long-running
 *  agent session never hits an auth failure mid-call. */
async function ensureSession(): Promise<Session> {
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
  if (session && session.expiresAt > fiveMinutesFromNow) return session;

  const res = await fetch(`${gatewayUrl}/login`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    throw new Error(`Login to ${gatewayUrl} failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string; expiresAt: string };
  session = { token: body.token, expiresAt: new Date(body.expiresAt) };
  return session;
}

/** Connects fresh for every call rather than holding one long-lived connection open --
 *  simpler to reason about than juggling reconnects on token refresh, and each call here
 *  is already a full HTTP round trip regardless. */
async function withRemoteClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const { token } = await ensureSession();
  const client = new Client({ name: "mcp-trust-gateway-bridge", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const server = new Server({ name: "mcp-trust-gateway-bridge", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await withRemoteClient((client) => client.listTools());
    return result as unknown as ServerResult;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await withRemoteClient((client) =>
      client.callTool({ name: request.params.name, arguments: request.params.arguments as Record<string, unknown> }),
    );
    return result as unknown as ServerResult;
  });

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error("[mcp-trust-gateway-bridge] fatal:", error);
  process.exit(1);
});
