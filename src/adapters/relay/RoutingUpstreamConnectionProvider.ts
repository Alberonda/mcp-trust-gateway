import type { EncryptedUpstreamCredential, UpstreamServer } from "../../domain/types.js";
import type { ConnectedUpstream, UpstreamConnectionProvider } from "../../ports/UpstreamConnectionProvider.js";

/**
 * Picks which real UpstreamConnectionProvider handles a given server, based on
 * `server.requiresRelay` (see migrations/008_relay_agents.sql) — everything else
 * (domain code, both composition roots) only ever sees one UpstreamConnectionProvider and
 * has no idea this routing exists.
 */
export class RoutingUpstreamConnectionProvider implements UpstreamConnectionProvider {
  constructor(
    private readonly local: UpstreamConnectionProvider,
    private readonly relay: UpstreamConnectionProvider,
  ) {}

  connect(server: UpstreamServer, credential: EncryptedUpstreamCredential | null): Promise<ConnectedUpstream> {
    return (server.requiresRelay ? this.relay : this.local).connect(server, credential);
  }
}
