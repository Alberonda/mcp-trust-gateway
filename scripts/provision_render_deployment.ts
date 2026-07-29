import pg from "pg";
import { loadBaseConfig } from "../src/config.js";
import { provisionUserWithIdentity } from "./lib/provisionUser.js";
import { registerServer } from "./lib/registerServer.js";

/**
 * One-off: provisions the first real user for the Render-hosted deployment. Deliberately
 * uses the "memory" reference MCP server (an in-memory knowledge graph, no filesystem or
 * credential dependency) instead of the filesystem server used for local testing --
 * a filesystem path on the operator's own Mac wouldn't exist inside Render's container,
 * so it can't be reused for a remote deployment's sanity check.
 */

async function main(): Promise<void> {
  const config = loadBaseConfig();
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();

  const server = await registerServer(client, config.encryptionKey, {
    name: "memory-demo",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
  });

  const { userId, apiKey } = await provisionUserWithIdentity(client, "alberto-render-deployment");

  await client.query(`INSERT INTO permissions (user_id, server_id, tool_name) VALUES ($1, $2, NULL)`, [
    userId,
    server.id,
  ]);

  await client.end();

  console.log("Servidor real registrado: memory-demo -> npx @modelcontextprotocol/server-memory");
  console.log(`GATEWAY_API_KEY=${apiKey}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
