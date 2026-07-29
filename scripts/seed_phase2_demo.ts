import pg from "pg";
import { loadBaseConfig } from "../src/config.js";
import { provisionUserWithIdentity } from "./lib/provisionUser.js";
import { registerServer } from "./lib/registerServer.js";

/**
 * One-off seed for manually demonstrating Phase 2's Claim A (governance across multiple
 * servers) end to end against two real filesystem MCP servers pointed at different
 * directories. See DESIGN.md's Phase 2 verification plan.
 *
 * Sets up:
 *   - two upstream_servers rows: sandbox-a, sandbox-b (different directories)
 *   - "narrow-agent": permission on sandbox-a only
 *   - "broad-agent": permission on both
 */

async function main(): Promise<void> {
  const config = loadBaseConfig();
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();

  const serverA = await registerServer(client, config.encryptionKey, {
    name: "sandbox-a",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/mcp-test-sandbox-a"],
  });
  const serverB = await registerServer(client, config.encryptionKey, {
    name: "sandbox-b",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/mcp-test-sandbox-b"],
  });

  const narrow = await provisionUserWithIdentity(client, "narrow-agent");
  await client.query(`INSERT INTO permissions (user_id, server_id, tool_name) VALUES ($1, $2, NULL)`, [
    narrow.userId,
    serverA.id,
  ]);

  const broad = await provisionUserWithIdentity(client, "broad-agent");
  await client.query(`INSERT INTO permissions (user_id, server_id, tool_name) VALUES ($1, $2, NULL)`, [
    broad.userId,
    serverA.id,
  ]);
  await client.query(`INSERT INTO permissions (user_id, server_id, tool_name) VALUES ($1, $2, NULL)`, [
    broad.userId,
    serverB.id,
  ]);

  await client.end();

  console.log("narrow-agent (sandbox-a only):", narrow.apiKey);
  console.log("broad-agent  (sandbox-a + b): ", broad.apiKey);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
