import { createHash, randomBytes } from "node:crypto";
import { SESSION_TOKEN_PREFIX, SESSION_TOKEN_RANDOM_BYTES } from "../../domain/constants.js";

/**
 * Session tokens are server-generated, high-entropy random strings — the same threat
 * model as API keys (see security/apiKeys.ts's docstring), just short-lived and issued
 * via a login step instead of provisioned once by an operator. A fast hash (SHA-256) is
 * appropriate here for the same reason it is for API keys: we're comparing against a
 * secret with enough entropy that a fast hash's speed isn't a brute-forcing weakness the
 * way it would be for a human-chosen password.
 */

export interface GeneratedSessionToken {
  /** Returned to the caller exactly once, from /login — never stored, never logged. */
  readonly plaintext: string;
  /** What actually goes into sessions.token_hash. */
  readonly hash: string;
}

export function generateSessionToken(): GeneratedSessionToken {
  const plaintext = `${SESSION_TOKEN_PREFIX}${randomBytes(SESSION_TOKEN_RANDOM_BYTES).toString("base64url")}`;
  return { plaintext, hash: hashSessionToken(plaintext) };
}

export function hashSessionToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}
