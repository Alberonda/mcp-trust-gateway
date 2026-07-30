import type { InvitationToken } from "../../domain/types.js";
import type { InvitationTokenRepository, NewInvitationToken } from "../../ports/InvitationTokenRepository.js";
import type { Queryable } from "../../ports/Queryable.js";

interface InvitationTokenRow {
  id: string;
  roleId: string;
  expiresAt: Date;
  usedAt: Date | null;
}

const TOKEN_COLUMNS = `id, role_id AS "roleId", expires_at AS "expiresAt", used_at AS "usedAt"`;

function mapRow(row: InvitationTokenRow): InvitationToken {
  return { id: row.id, roleId: row.roleId, expiresAt: row.expiresAt, usedAt: row.usedAt };
}

export class PostgresInvitationTokenRepository implements InvitationTokenRepository {
  constructor(private readonly db: Queryable) {}

  async create(token: NewInvitationToken): Promise<InvitationToken> {
    const { rows } = await this.db.query<InvitationTokenRow>(
      `INSERT INTO invitation_tokens (token_hash, role_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING ${TOKEN_COLUMNS}`,
      [token.tokenHash, token.roleId, token.createdBy, token.expiresAt],
    );
    return mapRow(rows[0]);
  }

  async findByHash(tokenHash: string): Promise<InvitationToken | null> {
    const { rows } = await this.db.query<InvitationTokenRow>(
      `SELECT ${TOKEN_COLUMNS} FROM invitation_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async markUsed(tokenId: string, usedBy: string): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE invitation_tokens SET used_at = now(), used_by = $2 WHERE id = $1 RETURNING id`,
      [tokenId, usedBy],
    );
    if (rows.length === 0) {
      throw new Error(`No invitation token with id "${tokenId}" — cannot mark a token used that doesn't exist.`);
    }
  }
}
