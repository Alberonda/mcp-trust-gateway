import pg from "pg";
import { provisionUserWithIdentity } from "./lib/provisionUser.js";

/**
 * One-off: sets up the first real (non-demo) user for day-to-day use, with a real
 * filesystem server pointed at a real sandbox directory. Not meant to be re-run — running
 * it twice would fail on the unique server/user name constraints, which is intentional
 * (this isn't a general provisioning tool, see DESIGN.md's backlog item about that gap).
 */

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set.");

  const client = new pg.Client({ connectionString });
  await client.connect();

  const {
    rows: [server],
  } = await client.query<{ id: string }>(
    `INSERT INTO upstream_servers (name, command) VALUES ($1, $2) RETURNING id`,
    ["personal-sandbox", "npx -y @modelcontextprotocol/server-filesystem /Users/AREYESM/mcp-gateway-sandbox"],
  );

  const { userId, apiKey } = await provisionUserWithIdentity(client, "alberto-devin-cli");

  await client.query(`INSERT INTO permissions (user_id, server_id, tool_name) VALUES ($1, $2, NULL)`, [
    userId,
    server.id,
  ]);

  await client.end();

  console.log("Servidor real registrado: personal-sandbox -> /Users/AREYESM/mcp-gateway-sandbox");
  console.log(`GATEWAY_API_KEY=${apiKey}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
