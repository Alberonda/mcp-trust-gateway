/** Domain types shared by every repository — plain data, no SQL or pg-specific shapes. */

export interface Identity {
  readonly id: string;
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
