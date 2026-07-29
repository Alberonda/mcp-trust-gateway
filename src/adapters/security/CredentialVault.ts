import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GCM_IV_LENGTH_BYTES } from "../../domain/constants.js";
import type { CredentialVault, EncryptedPayload } from "../../ports/CredentialVault.js";

/**
 * Application-level AES-256-GCM for the upstream credential vault (upstream_servers'
 * encrypted_credential column).
 *
 * Deliberately not delegated to a Postgres extension (pgcrypto) — see DESIGN.md's
 * decisions table: keeping the encryption logic here makes it portable if the database
 * ever changes, and keeps the key entirely out of the database process.
 *
 * The key is a constructor argument, not read from process.env here — see config.ts.
 * That's what makes this class trivially testable with an arbitrary in-memory key.
 */

const ALGORITHM = "aes-256-gcm";

export class AesGcmCredentialVault implements CredentialVault {
  constructor(private readonly key: Buffer) {}

  encrypt(plaintext: string): EncryptedPayload {
    const iv = randomBytes(GCM_IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag() };
  }

  /** Throws if the auth tag doesn't match (tampered ciphertext or wrong key). */
  decrypt(payload: EncryptedPayload): string {
    const decipher = createDecipheriv(ALGORITHM, this.key, payload.iv);
    decipher.setAuthTag(payload.authTag);
    const plaintext = Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  }
}
