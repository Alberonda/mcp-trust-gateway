import pg from "pg";
import { loadBaseConfig } from "../src/config.js";
import { provisionUserWithIdentity } from "./lib/provisionUser.js";
import { registerServer } from "./lib/registerServer.js";

/**
 * Seeds a test user/identity + upstream server + permission row against the official
 * filesystem MCP server (no credentials needed) — meant to be re-run on any fresh setup
 * (see README.md's "Setup"), not a one-time thing tied to this specific installation.
 * Not the long-term way to provision real users — see scripts/README.md for that.
 */

async function main(): Promise<void> {
  const config = loadBaseConfig();
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();

  const { userId, apiKey } = await provisionUserWithIdentity(client, "test-identity");

  const server = await registerServer(client, {
    name: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/mcp-test-sandbox"],
  });

  await client.query(`INSERT INTO permissions (user_id, server_id, tool_name) VALUES ($1, $2, NULL)`, [
    userId,
    server.id,
  ]);

  await client.end();

  console.log("Seeded test-identity with access to all tools on the filesystem server.");
  console.log(`GATEWAY_API_KEY=${apiKey}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
