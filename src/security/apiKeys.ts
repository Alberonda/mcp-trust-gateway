import { createHash, randomBytes } from "node:crypto";
import { API_KEY_PREFIX, API_KEY_RANDOM_BYTES } from "../constants.js";

/**
 * Gateway API keys are high-entropy random strings (not user-chosen passwords), so a fast
 * salted-free hash (SHA-256) is appropriate here to verify a presented key against
 * identities.api_key_hash — unlike a login password, which would need a slow KDF
 * (argon2/bcrypt) to resist brute-forcing a low-entropy secret. Phase 2's session tokens
 * will likely need different handling; keep that decision separate from this one.
 */

export interface GeneratedApiKey {
  /** Shown to the user exactly once — never stored, never logged. */
  readonly plaintext: string;
  /** What actually goes into identities.api_key_hash. */
  readonly hash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const plaintext = `${API_KEY_PREFIX}${randomBytes(API_KEY_RANDOM_BYTES).toString("base64url")}`;
  return { plaintext, hash: hashApiKey(plaintext) };
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}
