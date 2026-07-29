import pg from "pg";
import { generateApiKey } from "../src/crypto.js";

/**
 * One-off helper to seed a test identity + upstream server + permission row so Phase 1
 * can be exercised end to end against the official filesystem MCP server (no credentials
 * needed). Not meant to be the long-term way to provision identities — that's Phase 2's
 * job (see DESIGN.md) — this only exists to get something runnable for the first test.
 */

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set.");

  const client = new pg.Client({ connectionString });
  await client.connect();

  const { plaintext, hash } = generateApiKey();

  const { rows: [identity] } = await client.query(
    `INSERT INTO identities (name, api_key_hash) VALUES ($1, $2) RETURNING id`,
    ["test-identity", hash],
  );

  const { rows: [server] } = await client.query(
    `INSERT INTO upstream_servers (name, command) VALUES ($1, $2) RETURNING id`,
    ["filesystem", "npx -y @modelcontextprotocol/server-filesystem /tmp/mcp-test-sandbox"],
  );

  await client.query(
    `INSERT INTO permissions (identity_id, server_id, tool_name) VALUES ($1, $2, NULL)`,
    [identity.id, server.id],
  );

  await client.end();

  console.log("Seeded test-identity with access to all tools on the filesystem server.");
  console.log(`GATEWAY_API_KEY=${plaintext}`);
  console.log(`UPSTREAM_SERVER_NAME=filesystem`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
