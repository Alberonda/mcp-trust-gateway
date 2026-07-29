import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { UpstreamServer } from "../db/types.js";
import type { CredentialVault } from "../security/vault.js";
import type { ToolCallResult, UpstreamToolClient } from "./UpstreamToolClient.js";

/** A live connection to one real upstream MCP server, plus how to tear it down. */
export interface ConnectedUpstream {
  readonly client: UpstreamToolClient;
  close(): Promise<void>;
}

export interface UpstreamConnectionProvider {
  connect(server: UpstreamServer): Promise<ConnectedUpstream>;
}

/**
 * Spawns a fresh subprocess for the given real MCP server on every connect() call, closed
 * via the returned close(). Used by both entry points (stdio mode's index.ts and HTTP
 * mode's httpServer.ts) so the credential-decrypt-and-spawn logic exists in exactly one
 * place.
 *
 * Deliberately not a shared pool across sessions/identities yet — see DESIGN.md's Phase
 * 2.5 notes. This interface exists specifically so introducing pooling later (e.g. a
 * PooledUpstreamConnectionProvider reusing one subprocess across every identity permitted
 * on that server) is a new implementation of the same interface, not a change to every
 * call site.
 */
export class PerSessionUpstreamConnectionProvider implements UpstreamConnectionProvider {
  constructor(private readonly vault: CredentialVault) {}

  async connect(server: UpstreamServer): Promise<ConnectedUpstream> {
    const env = server.credential ? this.decryptEnv(server) : undefined;

    const client = new Client({ name: "mcp-trust-gateway", version: "0.1.0" });
    await client.connect(
      new StdioClientTransport({
        command: server.command,
        args: [...server.args],
        env: env ? ({ ...process.env, ...env } as Record<string, string>) : undefined,
      }),
    );

    return {
      client: {
        listTools: () => client.listTools(),
        callTool: (name, callArgs) =>
          client.callTool({ name, arguments: callArgs as Record<string, unknown> }) as Promise<ToolCallResult>,
      },
      close: () => client.close(),
    };
  }

  /** The stored credential decrypts to a JSON-serialized map of every env var this server
   *  needs (see db/types.ts's UpstreamServer doc) — not a single opaque secret. A parse
   *  failure here means the stored data is corrupt or predates this format, which is
   *  worth failing loudly on rather than silently spawning the server with no env at all. */
  private decryptEnv(server: UpstreamServer): Record<string, string> {
    const plaintext = this.vault.decrypt(server.credential!);
    try {
      return JSON.parse(plaintext) as Record<string, string>;
    } catch (error) {
      throw new Error(
        `Stored env for upstream server "${server.name}" is not valid JSON — expected a {"KEY":"value"} map. ` +
          `Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
