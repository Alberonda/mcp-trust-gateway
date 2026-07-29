import { loadBaseConfig } from "../src/config.js";
import { createPool } from "../src/adapters/postgres/pool.js";
import { PostgresRoleRepository } from "../src/adapters/postgres/RoleRepository.js";
import { PostgresUserRepository } from "../src/adapters/postgres/UserRepository.js";

/**
 * Operator tool: creates the admin role if it doesn't already exist, and grants it to one
 * named user — meant to be run once, by hand, to bootstrap the very first admin. Not run
 * automatically by any migration: silently granting admin to whoever happened to exist in
 * the database at migration time would be a real privilege-escalation surprise, not a
 * convenience. See DESIGN.md's "Role-based access control" for why.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/bootstrap_admin.ts <user-name>
 */
async function main(): Promise<void> {
  const [userName] = process.argv.slice(2);
  if (!userName) {
    console.error("Usage: bootstrap_admin.ts <user-name>");
    process.exit(1);
  }

  const config = loadBaseConfig();
  const pool = createPool(config.databaseUrl);
  const roles = new PostgresRoleRepository(pool);
  const users = new PostgresUserRepository(pool);

  const user = await users.findByName(userName);
  if (!user) throw new Error(`No user named "${userName}". Provision one first (see scripts/lib/provisionUser.ts).`);

  const adminRole = (await roles.findByName("admin")) ?? (await roles.create("admin", true));
  await roles.assignToUser(user.id, adminRole.id);
  await pool.end();

  console.log(`"${userName}" is now an admin — can use manage_roles to create roles, assign them, and manage users/credentials.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
