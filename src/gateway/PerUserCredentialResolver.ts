import type { UserCredentialRepository } from "../db/UserCredentialRepository.js";
import type { UpstreamServer } from "../db/types.js";

/**
 * Resolves which credential a given user should actually use for a server — their own
 * override if they have one, otherwise the server's own default (still useful for
 * genuinely shared resources, e.g. a read-only sandbox everyone is meant to share).
 *
 * Kept as its own small class specifically so UpstreamConnectionProvider never needs to
 * know a per-user override concept exists at all — it just connects to whatever
 * UpstreamServer object it's handed, with whatever credential is already resolved into
 * it. This is what's called once per accessible server, per session, right before
 * connecting.
 */
export class PerUserCredentialResolver {
  constructor(private readonly userCredentials: UserCredentialRepository) {}

  async resolve(server: UpstreamServer, userId: string): Promise<UpstreamServer> {
    const override = await this.userCredentials.findOverride(userId, server.id);
    return override ? { ...server, credential: override } : server;
  }
}
