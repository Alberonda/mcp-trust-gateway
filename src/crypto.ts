import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Application-level AES-256-GCM for the upstream credential vault.
 *
 * Deliberately not delegated to a Postgres extension (pgcrypto) — see DESIGN.md's
 * decisions table: keeping the encryption logic here makes it portable if the
 * database ever changes, and keeps the key entirely out of the database process.
 */

const ALGORITHM = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const key = process.env.GATEWAY_ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      "GATEWAY_ENCRYPTION_KEY is not set. Generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  const buf = Buffer.from(key, "hex");
  if (buf.length !== 32) {
    throw new Error("GATEWAY_ENCRYPTION_KEY must be a 32-byte value encoded as 64 hex characters.");
  }
  return buf;
}

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/** Encrypts a plaintext secret (e.g. a real upstream API key) for storage in upstream_servers. */
export function encryptSecret(plaintext: string): EncryptedPayload {
  const key = getEncryptionKey();
  const iv = randomBytes(12); // 96-bit IV is the GCM-recommended size
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

/** Reverses encryptSecret(). Throws if the auth tag doesn't match (tampered or wrong key). */
export function decryptSecret(payload: EncryptedPayload): string {
  const key = getEncryptionKey();
  const decipher = createDecipheriv(ALGORITHM, key, payload.iv);
  decipher.setAuthTag(payload.authTag);
  const plaintext = Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * Generates a new gateway API key for an identity: the plaintext to hand to the user
 * once, plus the hash that actually gets stored (see hashApiKey — same hash is used to
 * verify a presented key later, since API keys are high-entropy random strings rather
 * than user-chosen passwords, a fast salted hash is appropriate here, unlike a login
 * password which would need something slow like argon2).
 */
export function generateApiKey(): { plaintext: string; hash: string } {
  const plaintext = `mtg_${randomBytes(24).toString("base64url")}`;
  return { plaintext, hash: hashApiKey(plaintext) };
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}
