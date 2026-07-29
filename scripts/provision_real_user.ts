import pg from "pg";
import { loadBaseConfig } from "../src/config.js";
import { provisionUserWithIdentity } from "./lib/provisionUser.js";
import { registerServer } from "./lib/registerServer.js";

/**
 * One-off: sets up the first real (non-demo) user for day-to-day use, with a real
 * filesystem server pointed at a real sandbox directory. Not meant to be re-run — running
 * it twice would fail on the unique server/user name constraints, which is intentional
 * (this isn't a general provisioning tool, see DESIGN.md's backlog item about that gap).
 */

async function main(): Promise<void> {
  const config = loadBaseConfig();
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();

  const server = await registerServer(client, config.encryptionKey, {
    name: "personal-sandbox",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/AREYESM/mcp-gateway-sandbox"],
  });

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
