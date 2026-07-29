import type { PermissionRepository } from "../db/PermissionRepository.js";
import type { UpstreamServerRepository } from "../db/UpstreamServerRepository.js";
import type { UserCredentialRepository } from "../db/UserCredentialRepository.js";
import type { CredentialVault } from "../security/vault.js";
import type { ToolCallResult } from "./UpstreamToolClient.js";

/**
 * Lets a user see what they can use and configure their own credentials for it, without
 * an operator ever needing to type a plaintext token on their behalf. Deliberately never
 * grants permission itself — a user can only set their own credential for a server they
 * already hold a role-granted permission on (see PermissionRepository); "who's allowed to
 * use what" stays an admin decision (see AdminToolHandler.ts), this only ever narrows
 * "with which exact credential."
 */

export interface ServiceStatus {
  readonly server: string;
  readonly status: "ready" | "needs_credential" | "not_permitted";
}

export class SelfServiceHandler {
  constructor(
    private readonly userId: string,
    private readonly permissions: PermissionRepository,
    private readonly upstreamServers: UpstreamServerRepository,
    private readonly userCredentials: UserCredentialRepository,
    private readonly vault: CredentialVault,
  ) {}

  /** Every registered server (the whitelist — see db/UpstreamServerRepository.ts), with
   *  this user's status for it. Listing what exists isn't itself a security leak (same
   *  principle as Claude Code showing every configured MCP, whether or not you've
   *  authenticated with it yet) — only *using* one is gated. */
  async listServices(): Promise<ServiceStatus[]> {
    const accessibleServerIds = new Set(await this.permissions.findAccessibleServerIds(this.userId));
    const allServers = await this.upstreamServers.findAll();

    return Promise.all(
      allServers.map(async (server) => {
        if (!accessibleServerIds.has(server.id)) {
          return { server: server.name, status: "not_permitted" as const };
        }
        const credential = await this.userCredentials.find(this.userId, server.id);
        return { server: server.name, status: credential ? ("ready" as const) : ("needs_credential" as const) };
      }),
    );
  }

  /** Sets this user's own credential for `serverName` — only if they already hold a
   *  role-granted permission on it. Never grants that permission itself. */
  async registerMyCredential(serverName: string, env: Record<string, string>): Promise<ToolCallResult> {
    const server = await this.upstreamServers.findByName(serverName);
    if (!server) {
      return { isError: true, content: [{ type: "text", text: `Unknown server "${serverName}". Call list_services first.` }] };
    }

    const accessibleServerIds = await this.permissions.findAccessibleServerIds(this.userId);
    if (!accessibleServerIds.includes(server.id)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `You don't have permission to use "${serverName}" yet — that's granted by an admin via a role, not something you can set for yourself. Ask an admin to grant your role access first.`,
          },
        ],
      };
    }

    await this.userCredentials.upsert(this.userId, server.id, this.vault.encrypt(JSON.stringify(env)));
    return { content: [{ type: "text", text: `Saved your own credential for "${serverName}" (keys: ${Object.keys(env).join(", ")}).` }] };
  }
}
