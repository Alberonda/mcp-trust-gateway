import type { EncryptedUpstreamCredential, UpstreamServer } from "../../domain/types.js";
import type { CredentialVault } from "../../ports/CredentialVault.js";
import type { RelayAgentRegistry, RelayConnectedResponse, RelayResultResponse } from "../../ports/RelayAgentRegistry.js";
import type { ConnectedUpstream, UpstreamConnectionProvider } from "../../ports/UpstreamConnectionProvider.js";
import type { ToolCallResult } from "../../ports/UpstreamToolClient.js";

/**
 * The other implementation of UpstreamConnectionProvider — for servers flagged
 * `requiresRelay` (see migrations/008_relay_agents.sql), spawning the subprocess
 * happens on a connected relay agent's machine instead of this process's own. Domain code
 * (connectAccessibleServers.ts, ToolCallHandler, ...) needs zero changes to use this
 * instead of PerSessionUpstreamConnectionProvider — that's the entire point of depending
 * on the port, not a concrete class.
 *
 * Still decrypts the credential here, exactly like the local provider does — the relay
 * agent receives only the already-decrypted env for one active call, never the ciphertext
 * or the master key. See relay-agent/'s README for the trust model this is built around.
 */
export class RelayUpstreamConnectionProvider implements UpstreamConnectionProvider {
  constructor(
    private readonly registry: RelayAgentRegistry,
    private readonly vault: CredentialVault,
  ) {}

  async connect(server: UpstreamServer, credential: EncryptedUpstreamCredential | null): Promise<ConnectedUpstream> {
    const env = credential ? this.decryptEnv(server.name, credential) : {};

    const connected = await this.registry.dispatch({
      type: "connect",
      requestId: "", // filled in by the registry
      command: server.command,
      args: server.args,
      env,
    });
    if (connected.type !== "connected") {
      throw new Error(`Relay agent returned an unexpected response type ("${connected.type}") for a connect request.`);
    }
    const connectionId = connected.connectionId;

    return {
      client: {
        listTools: async () => {
          const response = await this.registry.dispatch({ type: "listTools", requestId: "", connectionId });
          return this.unwrapResult(response);
        },
        callTool: async (name, args) => {
          const response = await this.registry.dispatch({
            type: "callTool",
            requestId: "",
            connectionId,
            toolName: name,
            arguments: args,
          });
          return this.unwrapResult(response) as ToolCallResult;
        },
      },
      close: async () => {
        await this.registry.dispatch({ type: "close", requestId: "", connectionId });
      },
    };
  }

  private unwrapResult(response: RelayConnectedResponse | RelayResultResponse): unknown {
    if (response.type !== "result") {
      throw new Error(`Relay agent returned an unexpected response type ("${response.type}") for a call.`);
    }
    return response.result;
  }

  /** The stored credential decrypts to a JSON-serialized map of every env var this server
   *  needs — same convention as PerSessionUpstreamConnectionProvider, so a server can be
   *  switched between local and relay execution without re-encrypting anything. */
  private decryptEnv(serverName: string, credential: EncryptedUpstreamCredential): Record<string, string> {
    const plaintext = this.vault.decrypt(credential);
    try {
      return JSON.parse(plaintext) as Record<string, string>;
    } catch (error) {
      throw new Error(
        `Stored env for upstream server "${serverName}" is not valid JSON — expected a {"KEY":"value"} map. ` +
          `Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
