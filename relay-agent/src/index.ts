import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";

/**
 * See README.md for what this is and the trust model it's built around. The request/
 * response message shapes below mirror the main package's src/ports/RelayAgentRegistry.ts
 * — duplicated rather than imported, so this stays a genuinely separate package with its
 * own minimal dependency footprint (same reasoning as bridge/).
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
