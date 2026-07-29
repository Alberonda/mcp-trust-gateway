import type { EncryptedUpstreamCredential } from "../domain/types.js";

/**
 * Every credential for talking to a real upstream server — per (user, server), with no
 * server-level default anywhere else to fall back to (see
 * migrations/006_remove_shared_upstream_credential.sql). Every user, including whoever
 * first registers a server, stores their own credential here the same way — there is no
 * privileged "default" user.
 */
export interface UserCredentialRepository {
  /** This user's own credential for this server, or null if they have none (they simply
   *  can't use this server if it needs one — there is nothing to fall back to). */
  find(userId: string, serverId: string): Promise<EncryptedUpstreamCredential | null>;

  /** Sets (or replaces) this user's own credential for this server. */
  upsert(userId: string, serverId: string, credential: EncryptedUpstreamCredential): Promise<void>;

  /** Removes this user's credential for this server. Idempotent — removing a row that
   *  doesn't exist is not an error. */
  remove(userId: string, serverId: string): Promise<void>;
}
