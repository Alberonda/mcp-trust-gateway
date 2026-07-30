import type { RoleRepository } from "../ports/RoleRepository.js";
import type { UpstreamServerRepository } from "../ports/UpstreamServerRepository.js";
import type { UserCredentialRepository } from "../ports/UserCredentialRepository.js";
import type { UserRepository } from "../ports/UserRepository.js";
import type { Embedder } from "../ports/Embedder.js";
import type { NewToolCatalogEntry, ToolCatalogRepository } from "../ports/ToolCatalogRepository.js";
import type { UpstreamConnectionProvider } from "../ports/UpstreamConnectionProvider.js";
import type { ToolCallResult } from "../ports/UpstreamToolClient.js";
import type { Identity } from "./types.js";
import { extractToolSummaries } from "./extractToolSummaries.js";

/**
 * Backs the manage_roles meta-tool — only ever exposed to identities whose user holds an
 * admin role (see ToolDiscoveryRouter's construction in the composition root, which
 * decides whether to include this handler at all). This class itself does NOT re-check
 * admin status on every call — that's deliberately the composition root's job, done once
 * when building the tool list for a session, consistent with how ToolCallHandler doesn't
 * re-check "is this server real" either. If this handler exists for a session at all, the
 * caller has already been confirmed to be an admin.
 */

type AdminAction =
  | "create_role"
  | "delete_role"
  | "assign_role"
  | "unassign_role"
  | "list_roles"
  | "list_users"
  | "delete_user"
  | "delete_credential"
  | "refresh_catalog";

function textResult(text: string): ToolCallResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): ToolCallResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export class AdminToolHandler {
  constructor(
    private readonly roles: RoleRepository,
    private readonly users: UserRepository,
    private readonly upstreamServers: UpstreamServerRepository,
    private readonly userCredentials: UserCredentialRepository,
    /** Only needed by refresh_catalog — connects using the admin's OWN credential for
     *  the server being refreshed (no exception to "no shared default credential" here
     *  either — see UserCredentialRepository's docstring). */
    private readonly connectionProvider: UpstreamConnectionProvider,
    private readonly toolCatalog: ToolCatalogRepository,
    private readonly embedder: Embedder,
    private readonly identity: Identity,
  ) {}

  async handle(action: string, params: Record<string, unknown>): Promise<ToolCallResult> {
    switch (action as AdminAction) {
      case "create_role":
        return this.createRole(params);
      case "delete_role":
        return this.deleteRole(params);
      case "assign_role":
        return this.assignRole(params);
      case "unassign_role":
        return this.unassignRole(params);
      case "list_roles":
        return this.listRoles();
      case "list_users":
        return this.listUsers();
      case "delete_user":
        return this.deleteUser(params);
      case "delete_credential":
        return this.deleteCredential(params);
      case "refresh_catalog":
        return this.refreshCatalog(params);
      default:
        return errorResult(
          `Unknown action "${action}". Valid actions: create_role, delete_role, assign_role, unassign_role, ` +
            "list_roles, list_users, delete_user, delete_credential, refresh_catalog.",
        );
    }
  }

  private async createRole(params: Record<string, unknown>): Promise<ToolCallResult> {
    const name = params.name;
    if (typeof name !== "string" || !name) return errorResult('create_role requires a "name" string.');
    const isAdmin = params.isAdmin === true;
    const role = await this.roles.create(name, isAdmin);
    return textResult(`Created role "${role.name}" (admin: ${role.isAdmin}).`);
  }

  private async deleteRole(params: Record<string, unknown>): Promise<ToolCallResult> {
    const name = params.name;
    if (typeof name !== "string" || !name) return errorResult('delete_role requires a "name" string.');
    const role = await this.roles.findByName(name);
    if (!role) return errorResult(`No role named "${name}".`);
    await this.roles.remove(role.id);
    return textResult(`Deleted role "${name}". Every permission granted to it, and every user's holding of it, is gone too.`);
  }

  private async assignRole(params: Record<string, unknown>): Promise<ToolCallResult> {
    const { userName, roleName } = params;
    if (typeof userName !== "string" || typeof roleName !== "string") {
      return errorResult('assign_role requires "userName" and "roleName" strings.');
    }
    const [user, role] = await Promise.all([this.users.findByName(userName), this.roles.findByName(roleName)]);
    if (!user) return errorResult(`No user named "${userName}".`);
    if (!role) return errorResult(`No role named "${roleName}".`);
    await this.roles.assignToUser(user.id, role.id);
    return textResult(`Assigned role "${roleName}" to user "${userName}".`);
  }

  private async unassignRole(params: Record<string, unknown>): Promise<ToolCallResult> {
    const { userName, roleName } = params;
    if (typeof userName !== "string" || typeof roleName !== "string") {
      return errorResult('unassign_role requires "userName" and "roleName" strings.');
    }
    const [user, role] = await Promise.all([this.users.findByName(userName), this.roles.findByName(roleName)]);
    if (!user) return errorResult(`No user named "${userName}".`);
    if (!role) return errorResult(`No role named "${roleName}".`);
    await this.roles.unassignFromUser(user.id, role.id);
    return textResult(`Unassigned role "${roleName}" from user "${userName}".`);
  }

  private async listRoles(): Promise<ToolCallResult> {
    const roles = await this.roles.listAll();
    return textResult(JSON.stringify(roles, null, 2));
  }

  private async listUsers(): Promise<ToolCallResult> {
    const users = await this.users.listAll();
    const withRoles = await Promise.all(
      users.map(async (user) => ({ name: user.name, roles: (await this.roles.findRolesForUser(user.id)).map((r) => r.name) })),
    );
    return textResult(JSON.stringify(withRoles, null, 2));
  }

  private async deleteUser(params: Record<string, unknown>): Promise<ToolCallResult> {
    const name = params.userName;
    if (typeof name !== "string" || !name) return errorResult('delete_user requires a "userName" string.');
    const user = await this.users.findByName(name);
    if (!user) return errorResult(`No user named "${name}".`);
    await this.users.remove(user.id);
    return textResult(`Deleted user "${name}" — their identities, role assignments, and stored credentials are gone too.`);
  }

  private async deleteCredential(params: Record<string, unknown>): Promise<ToolCallResult> {
    const { userName, serverName } = params;
    if (typeof userName !== "string" || typeof serverName !== "string") {
      return errorResult('delete_credential requires "userName" and "serverName" strings.');
    }
    const [user, server] = await Promise.all([this.users.findByName(userName), this.upstreamServers.findByName(serverName)]);
    if (!user) return errorResult(`No user named "${userName}".`);
    if (!server) return errorResult(`No server named "${serverName}".`);
    await this.userCredentials.remove(user.id, server.id);
    return textResult(`Deleted "${userName}"'s credential for "${serverName}". Their permission (if any) is unaffected.`);
  }

  /** Forces a rebuild of one server's cached tool_catalog — the manual escape hatch for
   *  "I know the real server's tools changed, don't wait for the TTL" (see
   *  ToolDiscoveryRouter's opportunistic refresh for the automatic path). Connects using
   *  this admin's OWN credential for the server, same as any other real connection —
   *  fails with a clear message if they don't have one, rather than silently using
   *  someone else's. */
  private async refreshCatalog(params: Record<string, unknown>): Promise<ToolCallResult> {
    const serverName = params.serverName;
    if (typeof serverName !== "string" || !serverName) return errorResult('refresh_catalog requires a "serverName" string.');
    const server = await this.upstreamServers.findByName(serverName);
    if (!server) return errorResult(`No server named "${serverName}".`);

    let connected;
    try {
      const credential = await this.userCredentials.find(this.identity.userId, server.id);
      connected = await this.connectionProvider.connect(server, credential);
    } catch (error) {
      return errorResult(
        `Could not connect to "${serverName}" to refresh its catalog (using your own credential, if any): ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    try {
      const summaries = extractToolSummaries(await connected.client.listTools());
      const entries: NewToolCatalogEntry[] = await Promise.all(
        summaries.map(async (tool) => ({
          toolName: tool.name,
          description: tool.description,
          embedding: await this.embedder.embed(`${tool.name}: ${tool.description}`),
        })),
      );
      await this.toolCatalog.replaceForServer(server.id, entries);
      return textResult(`Refreshed the tool catalog for "${serverName}": ${entries.length} tool(s) cataloged.`);
    } finally {
      await connected.close();
    }
  }
}
