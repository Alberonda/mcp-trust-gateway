import type { Queryable } from "../../src/db/Queryable.js";

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
