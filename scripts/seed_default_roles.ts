import pg from "pg";
import { loadBaseConfig } from "../src/config.js";
import { PostgresRoleRepository } from "../src/db/RoleRepository.js";
import { registerServer } from "./lib/registerServer.js";

/**
 * Operator tool: sets up two sensible default roles and the servers a "developer" role
 * would realistically need — idempotent, safe to re-run (skips anything that already
 * exists by name instead of failing on a unique-constraint violation).
 *
 * - "admin" role (is_admin = true) — created empty; use scripts/bootstrap_admin.ts to
 *   grant it to someone, and manage_roles for everything after that.
 * - "developer" role — granted blanket (every-tool) access to three real servers:
 *   jira, sonarqube, jenkins. Each is registered with no env of its own (see
 *   db/types.ts's UpstreamServer doc) — every developer registers their own credential
 *   via register_my_credential once an admin assigns them the role.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/seed_default_roles.ts
 */

const DEVELOPER_SERVERS = [
  { name: "jira", command: "/bin/bash", args: ["/Users/AREYESM/.copilot/mcp-wrappers/jira-atlassian.sh"] },
  { name: "sonarqube", command: "npx", args: ["-y", "sonarqube-server-mcp"] },
  { name: "jenkins", command: "npx", args: ["-y", "@kud/mcp-jenkins"] },
] as const;

async function main(): Promise<void> {
  const config = loadBaseConfig();
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  const roles = new PostgresRoleRepository(client);

  const existingAdminRole = await roles.findByName("admin");
  const adminRole = existingAdminRole ?? (await roles.create("admin", true));
  console.log(`admin role: ${adminRole.id} (${existingAdminRole ? "already existed" : "created"})`);

  const existingDeveloperRole = await roles.findByName("developer");
  const developerRole = existingDeveloperRole ?? (await roles.create("developer", false));
  console.log(`developer role: ${developerRole.id} (${existingDeveloperRole ? "already existed" : "created"})`);

  for (const spec of DEVELOPER_SERVERS) {
    const {
      rows: [existingServer],
    } = await client.query<{ id: string }>(`SELECT id FROM upstream_servers WHERE name = $1`, [spec.name]);
    const serverId = existingServer ? existingServer.id : (await registerServer(client, spec)).id;

    const { rows: existingGrant } = await client.query(
      `SELECT 1 FROM permissions WHERE role_id = $1 AND server_id = $2 AND tool_name IS NULL`,
      [developerRole.id, serverId],
    );
    if (existingGrant.length === 0) {
      await client.query(`INSERT INTO permissions (role_id, server_id, tool_name) VALUES ($1, $2, NULL)`, [developerRole.id, serverId]);
      console.log(`Granted "developer" blanket access to "${spec.name}".`);
    } else {
      console.log(`"developer" already had access to "${spec.name}" — skipped.`);
    }
  }

  await client.end();
  console.log("\nNext: scripts/bootstrap_admin.ts <your-user-name> to become the first admin.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
