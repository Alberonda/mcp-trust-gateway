import { generateSessionToken, hashSessionToken } from "../security/sessionTokens.js";
import type { CreatedSession, Session, SessionRepository } from "../../ports/SessionRepository.js";
import type { Queryable } from "../../ports/Queryable.js";

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
