import { generateApiKey } from "../adapters/security/apiKeys.js";
import { hashInvitationToken } from "../adapters/security/invitationTokens.js";
import type { IdentityRepository } from "../ports/IdentityRepository.js";
import type { InvitationTokenRepository } from "../ports/InvitationTokenRepository.js";
import type { RoleRepository } from "../ports/RoleRepository.js";
import type { UserRepository } from "../ports/UserRepository.js";

export type RedemptionResult = { readonly apiKey: string; readonly userName: string } | { readonly error: string };

/**
 * The other half of AdminToolHandler's create_invitation action — an admin issues a
 * one-time token, this is what happens when a brand new person redeems it (HTTP mode
 * only, see entrypoints/http/httpServer.ts's POST /redeem-invitation). Deliberately not a
 * meta-tool: it runs before any identity exists to authenticate an MCP session with at
 * all, so it can't go through the normal tools/call path the way every other admin/self-
 * service action does.
 */
export class InvitationRedemptionHandler {
  constructor(
    private readonly invitationTokens: InvitationTokenRepository,
    private readonly users: UserRepository,
    private readonly identities: IdentityRepository,
    private readonly roles: RoleRepository,
  ) {}

  async redeem(tokenPlaintext: string, requestedName: string): Promise<RedemptionResult> {
    const token = await this.invitationTokens.findByHash(hashInvitationToken(tokenPlaintext));
    if (!token) {
      return { error: "Invalid invitation token." };
    }
    if (token.usedAt) {
      return { error: "This invitation token has already been used — ask an admin for a new one." };
    }
    if (token.expiresAt.getTime() < Date.now()) {
      return { error: "This invitation token has expired — ask an admin for a new one." };
    }

    const existingUser = await this.users.findByName(requestedName);
    if (existingUser) {
      return { error: `The name "${requestedName}" is already taken — choose a different one and try again.` };
    }

    const user = await this.users.create(requestedName);
    const { plaintext, hash } = generateApiKey();
    await this.identities.create(user.id, requestedName, hash);
    await this.roles.assignToUser(user.id, token.roleId);
    await this.invitationTokens.markUsed(token.id, user.id);

    return { apiKey: plaintext, userName: user.name };
  }
}
