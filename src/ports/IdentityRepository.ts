import type { Identity } from "../domain/types.js";

/** ToolCallHandler depends on this interface, never on Postgres directly — that's what
 *  lets tests substitute an in-memory fake with zero database involved. */
export interface IdentityRepository {
  findByApiKeyHash(hash: string): Promise<Identity | null>;

  /** Resolves the identity a session token was issued for (see SessionRepository) —
   *  sessions store an identityId, not a full Identity, so this is how HTTP mode turns
   *  "which session is this" back into the Identity object ToolCallHandler/
   *  ToolDiscoveryRouter already know how to work with. */
  findById(id: string): Promise<Identity | null>;

  /** Creates a brand new identity for an already-existing userId, given an already-hashed
   *  API key — the plaintext key itself never passes through this method or gets stored
   *  anywhere (see adapters/security/apiKeys.ts, which generates it). Throws on a
   *  duplicate name (identities.name is UNIQUE) rather than silently overwriting one. */
  create(userId: string, name: string, apiKeyHash: string): Promise<Identity>;
}
