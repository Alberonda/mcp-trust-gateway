import { loadBaseConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { PostgresUpstreamServerRepository } from "../src/db/UpstreamServerRepository.js";
import { CredentialVault } from "../src/security/vault.js";

/**
 * Operator tool: rotates every env var for an existing upstream server, in place — the
 * server keeps its id/name/command/args, so every existing permission grant referencing
 * it keeps working unchanged. Only affects gateway sessions/processes started *after* the
 * rotation; anything already connected keeps using the env it started with until it
 * reconnects (both stdio mode's per-process connection and HTTP mode's per-session one are
 * short-lived enough that this is rarely worth engineering around further — see DESIGN.md).
 *
 * Usage:
 *   DATABASE_URL=... GATEWAY_ENCRYPTION_KEY=... \
 *     npx tsx scripts/rotate_upstream_credential.ts <server-name> '{"KEY":"new-value", ...}'
 *
 * Pass the FULL env map the server needs, not just the one value that changed — this
 * replaces the whole stored map, it doesn't merge into it.
 */
async function main(): Promise<void> {
  const [serverName, newEnvJson] = process.argv.slice(2);
  if (!serverName || !newEnvJson) {
    console.error(`Usage: rotate_upstream_credential.ts <server-name> '{"KEY":"new-value"}'`);
    process.exit(1);
  }

  let newEnv: Record<string, string>;
  try {
    newEnv = JSON.parse(newEnvJson) as Record<string, string>;
  } catch {
    throw new Error(`Expected valid JSON for the env map; got: ${newEnvJson}`);
  }

  const config = loadBaseConfig();
  const pool = createPool(config.databaseUrl);
  const upstreamServers = new PostgresUpstreamServerRepository(pool);
  const vault = new CredentialVault(config.encryptionKey);

  const server = await upstreamServers.findByName(serverName);
  if (!server) {
    throw new Error(`No upstream server named "${serverName}".`);
  }

  await upstreamServers.updateEnv(server.id, vault.encrypt(JSON.stringify(newEnv)));
  await pool.end();

  console.log(`Rotated the env vars for "${serverName}" (keys: ${Object.keys(newEnv).join(", ")}). Existing permission grants are unaffected.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
