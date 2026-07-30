import pg from "pg";
import { loadBaseConfig } from "../src/config.js";
import { DEFAULT_INVITATION_ROLE_NAME } from "../src/domain/constants.js";
import { PostgresPermissionRepository } from "../src/adapters/postgres/PermissionRepository.js";
import { PostgresRoleRepository } from "../src/adapters/postgres/RoleRepository.js";
import { registerServer } from "./lib/registerServer.js";

/**
 * Operator tool: sets up sensible default roles and the servers a "developer" role would
 * realistically need — idempotent, safe to re-run (skips anything that already exists by
 * name instead of failing on a unique-constraint violation).
 *
 * - "admin" role (is_admin = true) — created empty; use scripts/bootstrap_admin.ts to
 *   grant it to someone, and manage_roles for everything after that.
 * - "developer" role — granted blanket (every-tool) access to jira/sonarqube/jenkins.
 * - "basic" role (DEFAULT_INVITATION_ROLE_NAME — see manage_roles' create_invitation
 *   action) — granted blanket access to jira ONLY. Deliberately narrow: this is what a
 *   self-service invitation grants a brand new person with zero vetting beyond holding
 *   the token, so it must be safe to hand to anyone. Jira specifically is safe here only
 *   because it's registered pointing at the real mcp-atlassian binary below with each
 *   user bringing their OWN Jira API token via register_my_credential (see
 *   DESIGN.md's "Self-service onboarding") — it would NOT have been safe with an earlier
 *   version of this project's jira registration that wrapped a script reading a shared
 *   macOS Keychain entry regardless of which identity connected. If you register jira
 *   some other way that doesn't check a per-user credential, do NOT put it in "basic".
 *
 * ⚠️ **Only run this against a database whose gateway process actually has network
 * access to jira/sonarqube/jenkins.** jira (the real `mcp-atlassian`, via `uvx`) is a
 * genuine public SaaS product — reachable from anywhere, including a publicly-hosted
 * deployment. sonarqube/jenkins below are placeholder commands; if yours are only
 * reachable from a specific internal network, register them with `requiresRelay: true`
 * and route them through a connected relay-agent instead (see relay-agent/README.md) —
 * registering an internal-only server as directly reachable will spawn (no crash) but
 * can never complete a real call from a publicly-hosted process.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/seed_default_roles.ts
 */

const DEVELOPER_SERVERS = [
  { name: "jira", command: "uvx", args: ["mcp-atlassian", "--transport", "stdio"] },
  { name: "sonarqube", command: "npx", args: ["-y", "sonarqube-server-mcp"] },
  { name: "jenkins", command: "npx", args: ["-y", "@kud/mcp-jenkins"] },
] as const;

async function main(): Promise<void> {
  const config = loadBaseConfig();
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  const roles = new PostgresRoleRepository(client);
  const permissions = new PostgresPermissionRepository(client);

  const existingAdminRole = await roles.findByName("admin");
  const adminRole = existingAdminRole ?? (await roles.create("admin", true));
  console.log(`admin role: ${adminRole.id} (${existingAdminRole ? "already existed" : "created"})`);

  const existingDeveloperRole = await roles.findByName("developer");
  const developerRole = existingDeveloperRole ?? (await roles.create("developer", false));
  console.log(`developer role: ${developerRole.id} (${existingDeveloperRole ? "already existed" : "created"})`);

  const existingBasicRole = await roles.findByName(DEFAULT_INVITATION_ROLE_NAME);
  const basicRole = existingBasicRole ?? (await roles.create(DEFAULT_INVITATION_ROLE_NAME, false));
  console.log(`"${DEFAULT_INVITATION_ROLE_NAME}" role: ${basicRole.id} (${existingBasicRole ? "already existed" : "created"})`);

  const serverIdByName = new Map<string, string>();
  for (const spec of DEVELOPER_SERVERS) {
    const {
      rows: [existingServer],
    } = await client.query<{ id: string }>(`SELECT id FROM upstream_servers WHERE name = $1`, [spec.name]);
    const serverId = existingServer ? existingServer.id : (await registerServer(client, spec)).id;
    serverIdByName.set(spec.name, serverId);

    await permissions.grant(developerRole.id, serverId, null);
    console.log(`Ensured "developer" has blanket access to "${spec.name}".`);
  }

  const jiraServerId = serverIdByName.get("jira")!;
  await permissions.grant(basicRole.id, jiraServerId, null);
  console.log(`Ensured "${DEFAULT_INVITATION_ROLE_NAME}" has blanket access to "jira" (and nothing else).`);

  await client.end();
  console.log("\nNext: scripts/bootstrap_admin.ts <your-user-name> to become the first admin.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
