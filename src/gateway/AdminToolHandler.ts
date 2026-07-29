import type { RoleRepository } from "../db/RoleRepository.js";
import type { UpstreamServerRepository } from "../db/UpstreamServerRepository.js";
import type { UserCredentialRepository } from "../db/UserCredentialRepository.js";
import type { UserRepository } from "../db/UserRepository.js";
import type { ToolCallResult } from "./UpstreamToolClient.js";

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
  | "delete_credential";

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
      default:
        return errorResult(
          `Unknown action "${action}". Valid actions: create_role, delete_role, assign_role, unassign_role, list_roles, list_users, delete_user, delete_credential.`,
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
}
