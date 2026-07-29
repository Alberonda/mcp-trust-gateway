/** Domain types shared by every repository — plain data, no SQL or pg-specific shapes. */

/** A person or agent that permissions are actually granted to. One user can hold several
 *  identities (e.g. a laptop key and a CI key) that all share the same grants — see
 *  DESIGN.md's Phase 3 for why permissions moved from per-identity to per-user. */
export interface User {
  readonly id: string;
  readonly name: string;
}

/** One credential (API key or session token) that authenticates as a user. Permission
 *  checks operate on `userId`, never on `id` — `id` identifies *which* credential made a
 *  call, which is what audit_log records, kept separate from *who* it's allowed to act as. */
export interface Identity {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly apiKeyHash: string;
  readonly isActive: boolean;
}

export interface EncryptedUpstreamCredential {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
}

export interface UpstreamServer {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  /** Absent when the server needs no credential (e.g. the filesystem server). */
  readonly credential: EncryptedUpstreamCredential | null;
}
