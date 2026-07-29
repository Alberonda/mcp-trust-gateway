import type { Role } from "../domain/types.js";

/**
 * Roles are what permissions are actually granted to (see migrations/007_roles.sql).
 * Users hold zero or more roles; their effective access is the union of all of them.
 */
export interface RoleRepository {
  create(name: string, isAdmin: boolean): Promise<Role>;
  findByName(name: string): Promise<Role | null>;
  findById(id: string): Promise<Role | null>;
  listAll(): Promise<Role[]>;
  /** Every role this user holds. */
  findRolesForUser(userId: string): Promise<Role[]>;
  /** True if this user holds at least one role with isAdmin = true. */
  isUserAdmin(userId: string): Promise<boolean>;
  /** Idempotent — assigning a role the user already holds is a no-op, not an error. */
  assignToUser(userId: string, roleId: string): Promise<void>;
  /** Idempotent — unassigning a role the user doesn't hold is a harmless no-op. */
  unassignFromUser(userId: string, roleId: string): Promise<void>;
  /** Deletes the role entirely — cascades to user_roles and permissions rows referencing
   *  it (see migrations/007_roles.sql's ON DELETE CASCADE). Throws if roleId doesn't
   *  exist, since a silent no-op there would be a confusing way to fail. */
  remove(roleId: string): Promise<void>;
}
