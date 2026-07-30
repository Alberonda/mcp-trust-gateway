import { createHash, randomBytes } from "node:crypto";
import { INVITATION_TOKEN_PREFIX, INVITATION_TOKEN_RANDOM_BYTES } from "../../domain/constants.js";

/**
 * Same threat model as API keys/session tokens (see their own docstrings) — a
 * server-generated, high-entropy secret, never a human-chosen password, so a fast hash
 * (SHA-256) is the right comparison, not a slow KDF.
 */

export interface GeneratedInvitationToken {
  /** Shown to the admin who created it exactly once — never stored, never logged. */
  readonly plaintext: string;
  /** What actually goes into invitation_tokens.token_hash. */
  readonly hash: string;
}

export function generateInvitationToken(): GeneratedInvitationToken {
  const plaintext = `${INVITATION_TOKEN_PREFIX}${randomBytes(INVITATION_TOKEN_RANDOM_BYTES).toString("base64url")}`;
  return { plaintext, hash: hashInvitationToken(plaintext) };
}

export function hashInvitationToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}
