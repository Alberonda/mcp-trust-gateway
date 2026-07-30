/** Domain types shared by every repository — plain data, no SQL or pg-specific shapes. */

/** A person or agent that permissions are actually granted to (indirectly, via roles —
 *  see Role below). One user can hold several identities (e.g. a laptop key and a CI
 *  key) that all share the same grants — see DESIGN.md's Phase 3 for why permissions
 *  moved from per-identity to per-user, and its later role-based-access-control section
 *  for why they moved from per-user to per-role on top of that. */
export interface User {
  readonly id: string;
  readonly name: string;
}

/** What permissions are actually granted to (see migrations/007_roles.sql) — a user's
 *  effective access is the union of every role they hold. `isAdmin` roles may manage
 *  roles/users/credentials via the manage_roles meta-tool (see
 *  gateway/AdminToolHandler.ts) — there is nothing special about the *user* holding an
 *  admin role, only the role itself. */
export interface Role {
  readonly id: string;
  readonly name: string;
  readonly isAdmin: boolean;
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

/** Encrypts an arbitrary string — a JSON-serialized map of every env var a server needs
 *  (see UpstreamConnectionProvider), not a single opaque secret. CredentialVault doesn't
 *  care either way; it just encrypts/decrypts text. Always stored per-*user* (see
 *  db/UserCredentialRepository.ts) — there is no server-level default to fall back to; see
 *  migrations/006_remove_shared_upstream_credential.sql for why that was removed on
 *  purpose. */
export interface EncryptedUpstreamCredential {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
}

/** How to spawn one real MCP server — deliberately the same {command, args} shape every
 *  MCP client config already uses (Claude Desktop, Cursor, VS Code, Devin CLI...), so
 *  registering a server here is a direct translation of its existing client config, not a
 *  new format to learn. Deliberately carries no credential of its own — every user who
 *  needs one for this server has their own row in user_credentials instead (see that
 *  file's docstring for why a shared default was removed). */
export interface UpstreamServer {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** True if this server can only be reached from inside a specific network this gateway
   *  process may not itself be running in (see migrations/008_relay_agents.sql) — the
   *  composition root must use a relay-based UpstreamConnectionProvider for it instead of
   *  spawning the subprocess itself. */
  readonly requiresRelay: boolean;
}

/** A one-time, admin-issued token that lets a brand new person provision their own
 *  user/identity/API key over HTTP (`POST /redeem-invitation`) without an admin running a
 *  script by hand for every new teammate — see migrations/010_invitation_tokens.sql and
 *  DESIGN.md's "Self-service onboarding" section for why this exists and its real
 *  constraints (HTTP mode only; the role it grants must itself be safe to hand to a
 *  stranger with zero vetting beyond holding the token). */
export interface InvitationToken {
  readonly id: string;
  readonly roleId: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}
