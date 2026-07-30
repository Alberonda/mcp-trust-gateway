import { loadBaseConfig } from "../src/config.js";
import { createPool } from "../src/adapters/postgres/pool.js";
import { PostgresIdentityRepository } from "../src/adapters/postgres/IdentityRepository.js";
import { PostgresRoleRepository } from "../src/adapters/postgres/RoleRepository.js";
import { PostgresUserRepository } from "../src/adapters/postgres/UserRepository.js";
import { generateApiKey } from "../src/adapters/security/apiKeys.js";

/**
 * Operator tool: provisions a genuinely new real person — a user, their first identity
 * (API key), and optionally a role — in one step, without writing a one-off script by
 * hand (which is what this project's history actually did before this existed; see
 * DESIGN.md). For a self-service alternative that doesn't need an operator to run
 * anything per person, see manage_roles' create_invitation action (HTTP mode only) and
 * POST /redeem-invitation instead — this script is for stdio-mode users, or anyone an
 * admin would rather provision directly.
 *
 * Usage:
 *   DATABASE_URL=... GATEWAY_ENCRYPTION_KEY=... npx tsx scripts/provision_user.ts <name> [roleName]
 */
async function main(): Promise<void> {
  const [name, roleName] = process.argv.slice(2);
  if (!name) {
    console.error("Usage: provision_user.ts <name> [roleName]");
    process.exit(1);
  }

  const config = loadBaseConfig();
  const pool = createPool(config.databaseUrl);
  const users = new PostgresUserRepository(pool);
  const identities = new PostgresIdentityRepository(pool);
  const roles = new PostgresRoleRepository(pool);

  const existing = await users.findByName(name);
  if (existing) throw new Error(`A user named "${name}" already exists — use manage_roles' assign_role to give them a role instead.`);

  const user = await users.create(name);
  const { plaintext, hash } = generateApiKey();
  await identities.create(user.id, name, hash);
  console.log(`Provisioned "${name}" (user ${user.id}).`);
  console.log(`API key (shown once, give it to them directly — never store this yourself): ${plaintext}`);

  if (roleName) {
    const role = await roles.findByName(roleName);
    if (!role) throw new Error(`No role named "${roleName}" — create it first with manage_roles' create_role, or omit it and assign one later.`);
    await roles.assignToUser(user.id, role.id);
    console.log(`Assigned role "${roleName}".`);
  } else {
    console.log("No role assigned yet — use manage_roles' assign_role, or re-run with a roleName argument.");
  }

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
