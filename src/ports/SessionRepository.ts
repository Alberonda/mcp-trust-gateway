/** What a valid, unexpired session resolves to — enough to check permissions (userId) and
 *  attribute audit entries to the credential that logged in (identityId), without the
 *  caller needing to know anything about how sessions are stored. */
export interface Session {
  readonly userId: string;
  readonly identityId: string;
}

export interface CreatedSession {
  /** Returned to the caller exactly once — never stored, never logged. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface SessionRepository {
  /** Issues a new session token for identityId (acting as userId), valid for ttlMinutes. */
  create(userId: string, identityId: string, ttlMinutes: number): Promise<CreatedSession>;

  /** Resolves a presented token to the session it belongs to, or null if it doesn't exist
   *  or has expired — callers never need to check expiry separately. */
  findByToken(token: string): Promise<Session | null>;

  /** Invalidates a session immediately (logout) — idempotent, no error if already gone. */
  revoke(token: string): Promise<void>;
}
