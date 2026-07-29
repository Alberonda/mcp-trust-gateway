import type { EncryptedUpstreamCredential, UpstreamServer } from "../domain/types.js";
import type { UpstreamToolClient } from "./UpstreamToolClient.js";

/** A live connection to one real upstream MCP server, plus how to tear it down. */
export interface ConnectedUpstream {
  readonly client: UpstreamToolClient;
  close(): Promise<void>;
}

export interface UpstreamConnectionProvider {
  /** `credential` is resolved by the caller (see ports/UserCredentialRepository.ts) — this
   *  provider has no opinion on *whose* credential it is, only how to use one to spawn a
   *  server. Pass null for a server that needs no env at all. */
  connect(server: UpstreamServer, credential: EncryptedUpstreamCredential | null): Promise<ConnectedUpstream>;
}
