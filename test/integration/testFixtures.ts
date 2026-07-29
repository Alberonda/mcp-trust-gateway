import { randomUUID } from "node:crypto";
import type { Queryable } from "../../src/ports/Queryable.js";

/**
 * Shared seeding helpers for integration tests — every test needing a user/identity/server
 * combination builds it from these instead of duplicating the same INSERT statements
 * (and the users -> identities relationship they must satisfy) in every test file.
 */

export interface SeededIdentity {
  readonly userId: string;
  readonly identityId: string;
}

export async function seedUserAndIdentity(db: Queryable, name: string): Promise<SeededIdentity> {
  const {
    rows: [user],
  } = await db.query<{ id: string }>(`INSERT INTO users (name) VALUES ($1) RETURNING id`, [name]);
  const {
    rows: [identity],
  } = await db.query<{ id: string }>(
    `INSERT INTO identities (user_id, name, api_key_hash) VALUES ($1, $2, $3) RETURNING id`,
    [user.id, name, `hash-for-${name}`],
  );
  return { userId: user.id, identityId: identity.id };
}

export async function seedServer(db: Queryable, name: string, command = "irrelevant-command"): Promise<string> {
  const {
    rows: [server],
  } = await db.query<{ id: string }>(`INSERT INTO upstream_servers (name, command) VALUES ($1, $2) RETURNING id`, [
    name,
    command,
  ]);
  return server.id;
}

/** Grants `userId` a permission via a fresh, dedicated role — permissions are granted to
 *  roles, not users directly (see migrations/007_roles.sql), so tests that just want "this
 *  user can do X" without caring about role-sharing semantics go through this instead of
 *  inserting into `permissions` directly (which would need a role_id, not a user_id). */
export async function grantPermission(db: Queryable, userId: string, serverId: string, toolName: string | null): Promise<void> {
  const {
    rows: [role],
  } = await db.query<{ id: string }>(`INSERT INTO roles (name) VALUES ($1) RETURNING id`, [`test-role-${randomUUID()}`]);
  await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [userId, role.id]);
  await db.query(`INSERT INTO permissions (role_id, server_id, tool_name) VALUES ($1, $2, $3)`, [role.id, serverId, toolName]);
}
