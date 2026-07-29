import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pg from "pg";
import { generateApiKey } from "../../src/adapters/security/apiKeys.js";

/**
 * The real end-to-end proof for the relay agent: a server marked `requires_relay` (see
 * migrations/008_relay_agents.sql) is never spawned by the gateway process itself — a
 * separately spawned relay-agent process (the actual `relay-agent/` package, built and
 * run for real here, not faked) connects over a real WebSocket and executes it instead.
 * Verified manually first by checking which process's log line ("... running on stdio")
 * actually printed the subprocess startup message — it was the agent's, never the
 * gateway's — before writing this as an automated regression test.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see package.json's "test:e2e" script.`);
  return value;
}

const testDatabaseUrl = requireEnv("TEST_DATABASE_URL");
const encryptionKey = requireEnv("GATEWAY_ENCRYPTION_KEY");
const PORT = 34551;

function waitForHealthy(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async (): Promise<void> => {
      try {
        const res = await fetch(`${baseUrl}/health`);
        if (res.ok) return resolve();
      } catch {
        // Not up yet.
      }
      if (Date.now() > deadline) return reject(new Error(`${baseUrl}/health never became healthy within ${timeoutMs}ms.`));
      setTimeout(() => void attempt(), 200);
    };
    void attempt();
  });
}

function waitForLogLine(getLog: () => string, pattern: RegExp, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      if (pattern.test(getLog())) return resolve();
      if (Date.now() > deadline) return reject(new Error(`Expected log line matching ${pattern} never appeared within ${timeoutMs}ms.`));
      setTimeout(attempt, 200);
    };
    attempt();
  });
}

/** SIGKILL, not SIGTERM — this is test cleanup, not a graceful production shutdown, and
 *  a leftover process from a previous run of this exact test is *worse* than a slightly
 *  less polite kill (it silently holds the port the next run needs, or a hung tsx --test
 *  process needing to be found and killed by hand — the real thing that happened
 *  building this test in the first place). Waits for the real 'exit' event instead of
 *  firing and forgetting, so the caller can rely on the process actually being gone by
 *  the time this resolves. */
function killAndWait(child: import("node:child_process").ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Process (pid ${child.pid}) did not exit within ${timeoutMs}ms of SIGKILL.`)), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGKILL");
  });
}

test(
  "a server marked requires_relay is executed by a connected relay agent, never by the gateway process itself",
  { timeout: 60_000 },
  async () => {
    const db = new pg.Client({ connectionString: testDatabaseUrl });
    await db.connect();
    const suffix = randomUUID().slice(0, 8);

    const userKey = generateApiKey();
    const agentKey = generateApiKey();

    const {
      rows: [user],
    } = await db.query<{ id: string }>(`INSERT INTO users (name) VALUES ($1) RETURNING id`, [`e2e-relay-user-${suffix}`]);
    await db.query(`INSERT INTO identities (user_id, name, api_key_hash) VALUES ($1, $2, $3)`, [
      user.id,
      `e2e-relay-user-identity-${suffix}`,
      userKey.hash,
    ]);
    const {
      rows: [agentUser],
    } = await db.query<{ id: string }>(`INSERT INTO users (name) VALUES ($1) RETURNING id`, [`e2e-relay-agent-${suffix}`]);
    await db.query(`INSERT INTO identities (user_id, name, api_key_hash) VALUES ($1, $2, $3)`, [
      agentUser.id,
      `e2e-relay-agent-identity-${suffix}`,
      agentKey.hash,
    ]);

    const {
      rows: [role],
    } = await db.query<{ id: string }>(`INSERT INTO roles (name, is_admin) VALUES ($1, false) RETURNING id`, [`e2e-relay-role-${suffix}`]);
    await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [user.id, role.id]);

    const {
      rows: [server],
    } = await db.query<{ id: string }>(
      `INSERT INTO upstream_servers (name, command, args, requires_relay) VALUES ($1, $2, $3, true) RETURNING id`,
      [`e2e-relay-memory-${suffix}`, "npx", JSON.stringify(["-y", "@modelcontextprotocol/server-memory"])],
    );
    await db.query(`INSERT INTO permissions (role_id, server_id, tool_name) VALUES ($1, $2, NULL)`, [role.id, server.id]);

    const httpServerProcess = spawn("node", ["dist/entrypoints/http/httpServer.js"], {
      env: { ...process.env, DATABASE_URL: testDatabaseUrl, GATEWAY_ENCRYPTION_KEY: encryptionKey, HTTP_PORT: String(PORT), HTTP_HOST: "127.0.0.1" },
    });
    let httpServerLog = "";
    httpServerProcess.stdout.on("data", (chunk) => (httpServerLog += chunk.toString()));
    httpServerProcess.stderr.on("data", (chunk) => (httpServerLog += chunk.toString()));

    const relayAgentProcess = spawn("node", ["relay-agent/dist/index.js"], {
      env: { ...process.env, GATEWAY_API_KEY: agentKey.plaintext, GATEWAY_URL: `http://127.0.0.1:${PORT}` },
    });
    let relayAgentLog = "";
    relayAgentProcess.stdout.on("data", (chunk) => (relayAgentLog += chunk.toString()));
    relayAgentProcess.stderr.on("data", (chunk) => (relayAgentLog += chunk.toString()));

    try {
      const baseUrl = `http://127.0.0.1:${PORT}`;
      await waitForHealthy(baseUrl, 15_000);
      await waitForLogLine(() => httpServerLog, /Relay agent connected/, 10_000);

      const loginRes = await fetch(`${baseUrl}/login`, { method: "POST", headers: { Authorization: `Bearer ${userKey.plaintext}` } });
      assert.equal(loginRes.status, 200);
      const { token } = (await loginRes.json()) as { token: string };

      const client = new Client({ name: "e2e-relay-test", version: "0.0.1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
      );

      try {
        const found = await client.callTool({ name: "find_tool", arguments: { query: "" } });
        const tools = JSON.parse((found.content as { text: string }[])[0].text) as { server: string; name: string }[];
        assert.ok(
          tools.some((t) => t.server === `e2e-relay-memory-${suffix}`),
          "the relay-executed server's tools must be discoverable through the gateway",
        );

        const called = await client.callTool({
          name: "call_tool",
          arguments: { server: `e2e-relay-memory-${suffix}`, tool: "read_graph", arguments: {} },
        });
        assert.equal(called.isError, undefined, "the relay-executed call must succeed, not just be discoverable");
      } finally {
        await client.close();
      }

      // The actual proof this ran on the AGENT, not the gateway: the subprocess-startup
      // log line only ever appears in the agent's own output.
      await waitForLogLine(() => relayAgentLog, /running on stdio/, 5_000);
      assert.doesNotMatch(httpServerLog, /running on stdio/, "the gateway process itself must never have spawned the real subprocess");
    } finally {
      await Promise.all([killAndWait(httpServerProcess), killAndWait(relayAgentProcess)]);
      await db.query(`DELETE FROM roles WHERE name LIKE $1`, [`e2e-relay-%-${suffix}`]);
      await db.query(`DELETE FROM users WHERE name LIKE $1`, [`e2e-relay-%-${suffix}`]);
      await db.query(`DELETE FROM upstream_servers WHERE name LIKE $1`, [`%-${suffix}`]);
      await db.query(`DELETE FROM audit_log WHERE server_name LIKE $1`, [`%-${suffix}`]);
      await db.end();
    }
  },
);
