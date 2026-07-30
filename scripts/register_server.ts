import { loadBaseConfig } from "../src/config.js";
import { createPool } from "../src/adapters/postgres/pool.js";
import { PostgresRoleRepository } from "../src/adapters/postgres/RoleRepository.js";
import { PostgresPermissionRepository } from "../src/adapters/postgres/PermissionRepository.js";
import { registerServer } from "./lib/registerServer.js";

/**
 * Operator tool: registers a real MCP server from the CLI, in the same {command, args}
 * shape any MCP client config already uses — an alternative to manage_roles'
 * register_server action for anyone who'd rather run a script than call a meta-tool (or
 * needs to do this before an admin identity even exists). Optionally grants one role
 * blanket access to it in the same step.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/register_server.ts <name> <command> [roleName] -- <arg1> <arg2> ...
 *
 * Example:
 *   npx tsx scripts/register_server.ts github npx developer -- -y @modelcontextprotocol/server-github
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dashDashIndex = argv.indexOf("--");
  const before = dashDashIndex === -1 ? argv : argv.slice(0, dashDashIndex);
  const args = dashDashIndex === -1 ? [] : argv.slice(dashDashIndex + 1);
  const [name, command, roleName] = before;

  if (!name || !command) {
    console.error("Usage: register_server.ts <name> <command> [roleName] -- <arg1> <arg2> ...");
    process.exit(1);
  }

  const config = loadBaseConfig();
  const pool = createPool(config.databaseUrl);

  const {
    rows: [existing],
  } = await pool.query<{ id: string }>(`SELECT id FROM upstream_servers WHERE name = $1`, [name]);
  if (existing) throw new Error(`A server named "${name}" already exists — use manage_roles' grant_permission to change who can use it.`);

  const server = await registerServer(pool, { name, command, args });
  console.log(`Registered "${server.name}" (${server.command} ${server.args.join(" ")}).`);

  if (roleName) {
    const roles = new PostgresRoleRepository(pool);
    const role = await roles.findByName(roleName);
    if (!role) throw new Error(`No role named "${roleName}" — the server is registered, but grant access to it separately with manage_roles' grant_permission.`);
    await new PostgresPermissionRepository(pool).grant(role.id, server.id, null);
    console.log(`Granted "${roleName}" blanket access to "${server.name}".`);
  } else {
    console.log(`No role granted access yet — use manage_roles' grant_permission({roleName, serverName: "${server.name}"}).`);
  }

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
