export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/**
 * How the domain (SelfServiceHandler, ToolCallHandler's callers, both composition roots)
 * turns a real secret into something safe to store, and back again — without needing to
 * know or care which encryption scheme actually backs it. See
 * adapters/security/CredentialVault.ts for the one real implementation (AES-256-GCM).
 */
export interface CredentialVault {
  encrypt(plaintext: string): EncryptedPayload;
  /** Throws if the payload was tampered with or the key doesn't match. */
  decrypt(payload: EncryptedPayload): string;
}
