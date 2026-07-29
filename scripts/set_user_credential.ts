import { loadBaseConfig } from "../src/config.js";
import { createPool } from "../src/adapters/postgres/pool.js";
import { PostgresUpstreamServerRepository } from "../src/adapters/postgres/UpstreamServerRepository.js";
import { PostgresUserCredentialRepository } from "../src/adapters/postgres/UserCredentialRepository.js";
import { AesGcmCredentialVault } from "../src/adapters/security/CredentialVault.js";

/**
 * Operator tool: sets (or replaces) ONE user's own env/credential for an already-registered
 * server — see migrations/005_user_credentials.sql for why this exists. Every other user
 * with permission on the same server is unaffected; they keep using the server's own
 * default (or their own override, if they have one).
 *
 * Usage:
 *   DATABASE_URL=... GATEWAY_ENCRYPTION_KEY=... \
 *     npx tsx scripts/set_user_credential.ts <user-name> <server-name> '{"KEY":"this-users-own-value"}'
 *
 * <user-name> is the identity name (see scripts/lib/provisionUser.ts) — its owning user
 * is who the override is stored against, consistent with permissions already being
 * per-user rather than per-identity (see DESIGN.md's Phase 3a).
 */
async function main(): Promise<void> {
  const [identityName, serverName, envJson] = process.argv.slice(2);
  if (!identityName || !serverName || !envJson) {
    console.error(`Usage: set_user_credential.ts <user-name> <server-name> '{"KEY":"value"}'`);
    process.exit(1);
  }

  let env: Record<string, string>;
  try {
    env = JSON.parse(envJson) as Record<string, string>;
  } catch {
    throw new Error(`Expected valid JSON for the env map; got: ${envJson}`);
  }

  const config = loadBaseConfig();
  const pool = createPool(config.databaseUrl);
  const vault = new AesGcmCredentialVault(config.encryptionKey);
  const upstreamServers = new PostgresUpstreamServerRepository(pool);
  const userCredentials = new PostgresUserCredentialRepository(pool);

  const {
    rows: [identity],
  } = await pool.query<{ userId: string }>(`SELECT user_id AS "userId" FROM identities WHERE name = $1`, [identityName]);
  if (!identity) throw new Error(`No identity named "${identityName}".`);

  const server = await upstreamServers.findByName(serverName);
  if (!server) throw new Error(`No upstream server named "${serverName}".`);

  await userCredentials.upsert(identity.userId, server.id, vault.encrypt(JSON.stringify(env)));
  await pool.end();

  console.log(`Set "${identityName}"'s own credential for "${serverName}" (keys: ${Object.keys(env).join(", ")}). ` +
    `Every other user of "${serverName}" is unaffected.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
