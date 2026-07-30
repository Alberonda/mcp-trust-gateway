import type { InvitationToken } from "../domain/types.js";

export interface NewInvitationToken {
  readonly tokenHash: string;
  readonly roleId: string;
  readonly createdBy: string | null;
  readonly expiresAt: Date;
}

export interface InvitationTokenRepository {
  create(token: NewInvitationToken): Promise<InvitationToken>;
  /** null if no token has this hash at all — distinct from one that exists but is
   *  expired/already used, which InvitationRedemptionHandler checks separately so it can
   *  give a specific reason instead of a generic "invalid token" either way. */
  findByHash(tokenHash: string): Promise<InvitationToken | null>;
  /** Idempotent is deliberately NOT how this behaves — see InvitationRedemptionHandler,
   *  which never calls this twice for the same token (it checks usedAt first). Throws if
   *  tokenId doesn't exist, since a silent no-op there would hide a real bug. */
  markUsed(tokenId: string, usedBy: string): Promise<void>;
}
