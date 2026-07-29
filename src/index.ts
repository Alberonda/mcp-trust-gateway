import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { decryptSecret, hashApiKey } from "./crypto.js";
import { findIdentityByApiKeyHash, findUpstreamServerByName, isCallAllowed, writeAuditLog } from "./db.js";
import { redact } from "./redact.js";

/**
 * Phase 1 MVP: one gateway process proxies to exactly one upstream MCP server, for one
 * identity, authenticated via an environment variable (the natural fit for how MCP clients
 * launch local stdio servers — see README.md's client config example). Multi-server routing
 * and per-user session tokens are Phase 2 (see DESIGN.md).
 */

const apiKey = requireEnv("GATEWAY_API_KEY");
const upstreamServerName = requireEnv("UPSTREAM_SERVER_NAME");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

async function main(): Promise<void> {
  const identity = await findIdentityByApiKeyHash(hashApiKey(apiKey));
  if (!identity) {
    throw new Error("GATEWAY_API_KEY does not match any active identity.");
  }

  const upstream = await findUpstreamServerByName(upstreamServerName);
  if (!upstream) {
    throw new Error(`No upstream server registered as "${upstreamServerName}".`);
  }

  const upstreamCredential =
    upstream.encryptedCredential && upstream.credentialIv && upstream.credentialAuthTag
      ? decryptSecret({
          ciphertext: upstream.encryptedCredential,
          iv: upstream.credentialIv,
          authTag: upstream.credentialAuthTag,
        })
      : undefined;

  const [command, ...args] = upstream.command.split(" ");
  const upstreamClient = new Client({ name: "mcp-trust-gateway", version: "0.1.0" });
  await upstreamClient.connect(
    new StdioClientTransport({
      command,
      args,
      env: upstreamCredential ? { ...process.env, UPSTREAM_CREDENTIAL: upstreamCredential } : undefined,
    }),
  );

  const server = new Server({ name: "mcp-trust-gateway", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => upstreamClient.listTools());

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: toolArgs } = request.params;
    const startedAt = Date.now();

    const allowed = await isCallAllowed(identity.id, upstream.id, toolName);
    if (!allowed) {
      await writeAuditLog({
        identityId: identity.id,
        serverName: upstream.name,
        toolName,
        paramsRedacted: redact(toolArgs ?? {}),
        status: "denied",
        resultSummary: `Denied: identity "${identity.name}" has no permission for this tool.`,
        durationMs: Date.now() - startedAt,
      });
      return {
        isError: true,
        content: [{ type: "text", text: `Permission denied: "${identity.name}" cannot call "${toolName}" on "${upstream.name}".` }],
      };
    }

    try {
      const result = await upstreamClient.callTool({ name: toolName, arguments: toolArgs });
      await writeAuditLog({
        identityId: identity.id,
        serverName: upstream.name,
        toolName,
        paramsRedacted: redact(toolArgs ?? {}),
        status: result.isError ? "allowed_failure" : "allowed_success",
        resultSummary: summarizeResult(result),
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      await writeAuditLog({
        identityId: identity.id,
        serverName: upstream.name,
        toolName,
        paramsRedacted: redact(toolArgs ?? {}),
        status: "allowed_failure",
        resultSummary: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  });

  await server.connect(new StdioServerTransport());
}

/** A short, human-readable line for audit_log.result_summary — never the full result payload. */
function summarizeResult(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  const textBlock = Array.isArray(content)
    ? content.find((c): c is { type: "text"; text: string } => c?.type === "text")
    : undefined;
  const text = textBlock?.text ?? "";
  return text.length > 200 ? `${text.slice(0, 200)}…` : text || "(no text content)";
}

main().catch((error) => {
  console.error("[mcp-trust-gateway] fatal:", error);
  process.exit(1);
});
