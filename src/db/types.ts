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

/** Encrypts an arbitrary string — as of the {command, args, env} rework, that string is a
 *  JSON-serialized map of every env var the server needs (see UpstreamConnectionProvider),
 *  not a single opaque secret. CredentialVault doesn't care either way; it just
 *  encrypts/decrypts text. */
export interface EncryptedUpstreamCredential {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
}

/** How to spawn one real MCP server — deliberately the same {command, args, env} shape
 *  every MCP client config already uses (Claude Desktop, Cursor, VS Code, Devin CLI...),
 *  so registering a server here is a direct translation of its existing client config,
 *  not a new format to learn. */
export interface UpstreamServer {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Absent when the server needs no env vars at all (e.g. the filesystem server). */
  readonly credential: EncryptedUpstreamCredential | null;
}
