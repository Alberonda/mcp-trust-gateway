import { generateSessionToken, hashSessionToken } from "../security/sessionTokens.js";
import type { Queryable } from "./Queryable.js";

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

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly db: Queryable) {}

  async create(userId: string, identityId: string, ttlMinutes: number): Promise<CreatedSession> {
    const { plaintext, hash } = generateSessionToken();
    const {
      rows: [row],
    } = await this.db.query<{ expiresAt: Date }>(
      `INSERT INTO sessions (user_id, identity_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)
       RETURNING expires_at AS "expiresAt"`,
      [userId, identityId, hash, ttlMinutes],
    );
    return { token: plaintext, expiresAt: row.expiresAt };
  }

  async findByToken(token: string): Promise<Session | null> {
    const { rows } = await this.db.query<Session>(
      `SELECT user_id AS "userId", identity_id AS "identityId"
       FROM sessions WHERE token_hash = $1 AND expires_at > now()`,
      [hashSessionToken(token)],
    );
    return rows[0] ?? null;
  }

  async revoke(token: string): Promise<void> {
    await this.db.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashSessionToken(token)]);
  }
}
