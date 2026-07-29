import pg from "pg";
import { provisionUserWithIdentity } from "./lib/provisionUser.js";

/**
 * One-off helper to seed a test user/identity + upstream server + permission row so
 * Phase 1 can be exercised end to end against the official filesystem MCP server (no
 * credentials needed). Not meant to be the long-term way to provision users — this only
 * exists to get something runnable for a first test.
 */

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set.");

  const client = new pg.Client({ connectionString });
  await client.connect();

  const { userId, apiKey } = await provisionUserWithIdentity(client, "test-identity");

  const {
    rows: [server],
  } = await client.query<{ id: string }>(`INSERT INTO upstream_servers (name, command) VALUES ($1, $2) RETURNING id`, [
    "filesystem",
    "npx -y @modelcontextprotocol/server-filesystem /tmp/mcp-test-sandbox",
  ]);

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
