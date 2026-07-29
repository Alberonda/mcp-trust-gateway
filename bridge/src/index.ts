import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ServerResult } from "@modelcontextprotocol/sdk/types.js";

/** See README.md for what this is, when you need it, and the trust model it's built
 *  around. */

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
