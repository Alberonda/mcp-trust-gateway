import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import pg from "pg";
import { hashApiKey } from "../../src/adapters/security/apiKeys.js";

/**
 * Real-world incident, reproduced on purpose: a user permitted on two servers where one
 * (Jenkins, registered but never given credentials) exits immediately on startup used to
 * take the WHOLE session down — including access to the other, perfectly healthy server
 * (SonarQube). See gateway/connectAccessibleServers.ts's docstring for the fix
 * (Promise.allSettled instead of Promise.all) and its own unit tests for the
 * fakes-based coverage; this proves the same thing with a real spawned subprocess that
 * genuinely crashes, not a mock that returns a rejected promise.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see package.json's "test:e2e" script.`);
  return value;
}

const testDatabaseUrl = requireEnv("TEST_DATABASE_URL");

test(
  "a user permitted on a server that crashes on startup still gets a working session for every other server",
  { timeout: 60_000 },
  async () => {
    const db = new pg.Client({ connectionString: testDatabaseUrl });
    await db.connect();
    const suffix = randomUUID().slice(0, 8);

    try {
      const {
        rows: [user],
      } = await db.query<{ id: string }>(`INSERT INTO users (name) VALUES ($1) RETURNING id`, [`e2e-iso-user-${suffix}`]);
      const {
        rows: [role],
      } = await db.query<{ id: string }>(`INSERT INTO roles (name, is_admin) VALUES ($1, false) RETURNING id`, [`e2e-iso-role-${suffix}`]);
      await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [user.id, role.id]);

      const apiKey = `mtg_e2e_iso_${suffix}`;
      await db.query(`INSERT INTO identities (user_id, name, api_key_hash) VALUES ($1, $2, $3)`, [
        user.id,
        `e2e-iso-identity-${suffix}`,
        hashApiKey(apiKey),
      ]);

      // "healthy" behaves like sonarqube did in the real incident: a real MCP server that
      // starts and works fine. "crashes-on-startup" behaves like the misconfigured
      // jenkins did: a real process that exits immediately, closing its stdio transport.
      const {
        rows: [healthyServer],
      } = await db.query<{ id: string }>(`INSERT INTO upstream_servers (name, command, args) VALUES ($1, $2, $3) RETURNING id`, [
        `healthy-${suffix}`,
        "npx",
        JSON.stringify(["-y", "@modelcontextprotocol/server-memory"]),
      ]);
      const {
        rows: [crashingServer],
      } = await db.query<{ id: string }>(`INSERT INTO upstream_servers (name, command, args) VALUES ($1, $2, $3) RETURNING id`, [
        `crashes-on-startup-${suffix}`,
        "node",
        JSON.stringify(["-e", "process.exit(1)"]),
      ]);
      for (const serverId of [healthyServer.id, crashingServer.id]) {
        await db.query(`INSERT INTO permissions (role_id, server_id, tool_name) VALUES ($1, $2, NULL)`, [role.id, serverId]);
      }

      const client = new Client({ name: "e2e-isolation-test", version: "0.0.1" });
      await client.connect(
        new StdioClientTransport({
          command: "node",
          args: ["dist/entrypoints/stdio/index.js"],
          env: { ...process.env, GATEWAY_API_KEY: apiKey, DATABASE_URL: testDatabaseUrl, GATEWAY_ENCRYPTION_KEY: process.env.GATEWAY_ENCRYPTION_KEY! },
        }),
      );

      try {
        // The whole point: the session must exist at all (pre-fix, connecting to the
        // gateway itself would fail here, since the crashing server broke the
        // Promise.all before the MCP server was even constructed).
        const results = await client.callTool({ name: "find_tool", arguments: { query: "" } });
        const tools = JSON.parse((results.content as { text: string }[])[0].text) as { server: string }[];

        assert.ok(
          tools.some((t) => t.server === `healthy-${suffix}`),
          "the healthy server's tools must still be discoverable even though a sibling server crashed on startup",
        );
        assert.ok(
          !tools.some((t) => t.server === `crashes-on-startup-${suffix}`),
          "the crashing server correctly contributes no tools, but must not have broken the whole session",
        );
      } finally {
        await client.close();
      }
    } finally {
      await db.query(`DELETE FROM roles WHERE name LIKE $1`, [`e2e-iso-%-${suffix}`]);
      await db.query(`DELETE FROM users WHERE name LIKE $1`, [`e2e-iso-%-${suffix}`]);
      await db.query(`DELETE FROM upstream_servers WHERE name LIKE $1`, [`%-${suffix}`]);
      await db.query(`DELETE FROM audit_log WHERE server_name LIKE $1`, [`%-${suffix}`]);
      await db.end();
    }
  },
);
