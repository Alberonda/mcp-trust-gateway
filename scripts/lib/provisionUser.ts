import type pg from "pg";
import { generateApiKey } from "../../src/adapters/security/apiKeys.js";

export interface ProvisionedUser {
  readonly userId: string;
  readonly identityId: string;
  readonly apiKey: string;
}

/** Creates a user and its first identity (API key) together — every identity must belong
 *  to a user (see migrations/002_users.sql), so provisioning scripts always do both at
 *  once rather than inserting into `identities` directly. */
export async function provisionUserWithIdentity(client: pg.Client, name: string): Promise<ProvisionedUser> {
  const { plaintext, hash } = generateApiKey();

  const {
    rows: [user],
  } = await client.query<{ id: string }>(`INSERT INTO users (name) VALUES ($1) RETURNING id`, [name]);

  const {
    rows: [identity],
  } = await client.query<{ id: string }>(
    `INSERT INTO identities (user_id, name, api_key_hash) VALUES ($1, $2, $3) RETURNING id`,
    [user.id, name, hash],
  );

  return { userId: user.id, identityId: identity.id, apiKey: plaintext };
}
