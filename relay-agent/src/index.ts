import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";

/**
 * Executes real MCP server subprocesses on behalf of a remote mcp-trust-gateway
 * deployment, for servers only reachable from THIS machine's network (an internal
 * corporate SonarQube/Jenkins instance, say — see DESIGN.md's "Role-based access
 * control" postscripts for the real incident that made this necessary: a subprocess
 * spawning without crashing only proves the binary starts, not that the network call it
 * will eventually make can succeed).
 *
 * Holds exactly one secret locally — GATEWAY_API_KEY, a real, revocable identity's
 * credential, the same one any other client of the gateway would use. Never the database
 * URL, never the master encryption key, never a stored credential's ciphertext. The
 * gateway decrypts a server's credential itself and sends this process only the already-
 * decrypted env for one active connection, at the moment it's needed — this process
 * itself never touches Postgres, never sees any OTHER server's credential, and forgets
 * the one it did see the moment that connection closes.
 *
 * Deliberately not "another MCP server" — the direction of control is inverted from a
 * normal MCP client/server relationship (the gateway, not this process, initiates every
 * request), which is why this speaks its own small protocol instead of MCP's request/
 * response shape. See src/ports/RelayAgentRegistry.ts in the main package for that
 * protocol's real definition — duplicated here rather than imported, the same way
 * bridge/ doesn't import from the main package either, so this stays a genuinely
 * separate, minimal thing with its own dependency footprint.
 */

interface RelayRequest {
  readonly type: "connect" | "listTools" | "callTool" | "close";
  readonly requestId: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly connectionId?: string;
  readonly toolName?: string;
  readonly arguments?: unknown;
}

type RelayResponse =
  | { type: "connected"; requestId: string; connectionId: string }
  | { type: "result"; requestId: string; result: unknown }
  | { type: "error"; requestId: string; message: string };

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

const apiKey = requireEnv("GATEWAY_API_KEY");
const gatewayUrl = process.env.GATEWAY_URL ?? "https://mcp-trust-gateway.onrender.com";
const agentUrl = gatewayUrl.replace(/^http/, "ws") + "/agent";
const RECONNECT_DELAY_MS = 5000;

/** Every currently-open subprocess connection, keyed by an id this process makes up when
 *  asked to connect — the gateway only ever refers back to a connection by that id, never
 *  needs to know anything else about how it's implemented. */
const connections = new Map<string, Client>();

async function handleRequest(request: RelayRequest): Promise<RelayResponse> {
  switch (request.type) {
    case "connect": {
      const client = new Client({ name: "mcp-trust-gateway-relay-agent", version: "0.1.0" });
      await client.connect(
        new StdioClientTransport({
          command: request.command!,
          args: [...(request.args ?? [])],
          // Same allowlist-based env as the gateway's own PerSessionUpstreamConnectionProvider
          // (adapters/mcp/UpstreamConnectionProvider.ts) -- this process's own environment
          // (including GATEWAY_API_KEY) must never reach the spawned server either.
          env: { ...getDefaultEnvironment(), ...request.env },
        }),
      );
      const connectionId = randomUUID();
      connections.set(connectionId, client);
      return { type: "connected", requestId: request.requestId, connectionId };
    }

    case "listTools": {
      const client = requireConnection(request.connectionId);
      const result = await client.listTools();
      return { type: "result", requestId: request.requestId, result };
    }

    case "callTool": {
      const client = requireConnection(request.connectionId);
      const result = await client.callTool({ name: request.toolName!, arguments: request.arguments as Record<string, unknown> });
      return { type: "result", requestId: request.requestId, result };
    }

    case "close": {
      const client = connections.get(request.connectionId!);
      connections.delete(request.connectionId!);
      await client?.close();
      return { type: "result", requestId: request.requestId, result: null };
    }
  }
}

function requireConnection(connectionId: string | undefined): Client {
  const client = connectionId && connections.get(connectionId);
  if (!client) throw new Error(`No open connection with id "${connectionId}" (it may have already been closed).`);
  return client;
}

function connect(): void {
  const ws = new WebSocket(agentUrl, { headers: { Authorization: `Bearer ${apiKey}` } });

  ws.on("open", () => console.log(`[mcp-trust-gateway-relay-agent] Connected to ${gatewayUrl}.`));

  ws.on("message", (data) => {
    void (async () => {
      let request: RelayRequest;
      try {
        request = JSON.parse(data.toString()) as RelayRequest;
      } catch {
        return; // Not a well-formed request -- nothing we can even reply to.
      }
      try {
        const response = await handleRequest(request);
        ws.send(JSON.stringify(response));
      } catch (error) {
        ws.send(
          JSON.stringify({
            type: "error",
            requestId: request.requestId,
            message: error instanceof Error ? error.message : String(error),
          } satisfies RelayResponse),
        );
      }
    })();
  });

  ws.on("close", () => {
    console.warn(`[mcp-trust-gateway-relay-agent] Disconnected. Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
    setTimeout(connect, RECONNECT_DELAY_MS);
  });
  ws.on("error", (error) => console.error("[mcp-trust-gateway-relay-agent] Connection error:", error.message));
}

connect();
