import { loadBaseConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { PostgresUpstreamServerRepository } from "../src/db/UpstreamServerRepository.js";
import { CredentialVault } from "../src/security/vault.js";

/**
 * Operator tool: rotates the stored credential for an existing upstream server, in place —
 * the server keeps its id/name/command, so every existing permission grant referencing it
 * keeps working unchanged. Only affects gateway sessions/processes started *after* the
 * rotation; anything already connected keeps using the credential it started with until it
 * reconnects (both stdio mode's per-process connection and HTTP mode's per-session one are
 * short-lived enough that this is rarely worth engineering around further — see DESIGN.md).
 *
 * Usage:
 *   DATABASE_URL=... GATEWAY_ENCRYPTION_KEY=... \
 *     npx tsx scripts/rotate_upstream_credential.ts <server-name> <new-plaintext-credential>
 */
async function main(): Promise<void> {
  const [serverName, newCredential] = process.argv.slice(2);
  if (!serverName || !newCredential) {
    console.error("Usage: rotate_upstream_credential.ts <server-name> <new-plaintext-credential>");
    process.exit(1);
  }

  const config = loadBaseConfig();
  const pool = createPool(config.databaseUrl);
  const upstreamServers = new PostgresUpstreamServerRepository(pool);
  const vault = new CredentialVault(config.encryptionKey);

  const server = await upstreamServers.findByName(serverName);
  if (!server) {
    throw new Error(`No upstream server named "${serverName}".`);
  }

  await upstreamServers.updateCredential(server.id, vault.encrypt(newCredential));
  await pool.end();

  console.log(`Rotated the credential for "${serverName}". Existing permission grants are unaffected.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
