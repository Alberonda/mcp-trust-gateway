import type { UserCredentialRepository } from "../ports/UserCredentialRepository.js";
import type { UpstreamServer } from "./types.js";
import type { ConnectedUpstream, UpstreamConnectionProvider } from "../ports/UpstreamConnectionProvider.js";

export interface ConnectedServer {
  readonly server: UpstreamServer;
  readonly connected: ConnectedUpstream;
}

/**
 * Connects to every accessible server, isolating failures per server instead of letting
 * one bad connection take the whole session down.
 *
 * Found for real while building the role-based-access-control e2e test: a server that
 * needs credentials to even start (e.g. an MCP server that exits immediately without its
 * required env var) used to fail the single `Promise.all` covering every accessible
 * server — meaning a user with permission on N servers couldn't connect to ANY of them
 * the moment just one was misconfigured, even servers with zero relation to the broken
 * one. Reproduced against a real deployment: a user permitted on both `sonarqube`
 * (working) and `jenkins` (registered but never given credentials, so the process exits
 * immediately) couldn't get a session at all until `jenkins` was fixed or removed.
 *
 * `Promise.allSettled` instead of `Promise.all` fixes this — a session now has access to
 * every server that connected successfully, with failures logged (not silently dropped)
 * via `onConnectionFailed` so an operator can see what needs attention.
 */
export async function connectAccessibleServers(
  servers: readonly UpstreamServer[],
  userId: string,
  userCredentials: UserCredentialRepository,
  connectionProvider: UpstreamConnectionProvider,
  onConnectionFailed: (server: UpstreamServer, error: unknown) => void = (server, error) => {
    console.error(`[mcp-trust-gateway] Failed to connect to upstream server "${server.name}" — skipping it for this session:`, error);
  },
): Promise<ConnectedServer[]> {
  const results = await Promise.allSettled(
    servers.map(async (server): Promise<ConnectedServer> => {
      const credential = await userCredentials.find(userId, server.id);
      const connected = await connectionProvider.connect(server, credential);
      return { server, connected };
    }),
  );

  const succeeded: ConnectedServer[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      succeeded.push(result.value);
    } else {
      onConnectionFailed(servers[index], result.reason);
    }
  });
  return succeeded;
}
