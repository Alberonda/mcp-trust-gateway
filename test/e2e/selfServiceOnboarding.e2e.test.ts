import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pg from "pg";
import { PostgresRoleRepository } from "../../src/adapters/postgres/RoleRepository.js";
import { hashApiKey } from "../../src/adapters/security/apiKeys.js";

/**
 * A genuine end-to-end test of the self-service onboarding flow this project added
 * specifically so an admin doesn't have to run a provisioning script for every new
 * teammate: an admin issues a one-time invitation token (over a real stdio session, via
 * manage_roles), a brand new person redeems it over real HTTP (no prior identity at
 * all — that's the whole point) against the REAL BUILT httpServer.js, and the API key
 * that comes back is verified to actually work end to end, with the role it grants
 * correctly resolvable from the real database afterward.
 *
 * Requires TEST_DATABASE_URL, GATEWAY_ENCRYPTION_KEY, and a built dist/ (npm run build)
 * — see package.json's "test:e2e" script.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see package.json's "test:e2e" script.`);
  return value;
}

const testDatabaseUrl = requireEnv("TEST_DATABASE_URL");
const encryptionKeyHex = requireEnv("GATEWAY_ENCRYPTION_KEY");
const HTTP_PORT = 34_120; // a fixed, unlikely-to-collide port for this test only

function connectStdio(apiKey: string): Promise<Client> {
  const client = new Client({ name: "e2e-onboarding-test", version: "0.0.1" });
  return client
    .connect(
      new StdioClientTransport({
        command: "node",
        args: ["dist/entrypoints/stdio/index.js"],
        env: { ...process.env, GATEWAY_API_KEY: apiKey, DATABASE_URL: testDatabaseUrl, GATEWAY_ENCRYPTION_KEY: encryptionKeyHex },
      }),
    )
    .then(() => client);
}

async function loginOverHttp(apiKey: string, baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/login`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const { token } = (await res.json()) as { token: string };
  return token;
}

async function connectHttp(sessionToken: string, baseUrl: string): Promise<Client> {
  const client = new Client({ name: "e2e-onboarding-test-http", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${sessionToken}` } },
    }),
  );
  return client;
}

async function waitForHealthy(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // Not listening yet — retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`httpServer.js never became healthy within ${timeoutMs}ms`);
}

function spawnHttpServer(): ChildProcess {
  return spawn("node", ["dist/entrypoints/http/httpServer.js"], {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl, GATEWAY_ENCRYPTION_KEY: encryptionKeyHex, HTTP_PORT: String(HTTP_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test(
  "an admin-issued invitation, redeemed over real HTTP with no prior identity, produces a working API key with the right role",
  { timeout: 60_000 },
  async () => {
    const suffix = randomUUID().slice(0, 8);
    const db = new pg.Client({ connectionString: testDatabaseUrl });
    await db.connect();
    const roles = new PostgresRoleRepository(db);

    const adminRole = await roles.create(`e2e-onboarding-admin-${suffix}`, true);
    const basicRole = await roles.create(`e2e-onboarding-basic-${suffix}`, false);
    const {
      rows: [adminUser],
    } = await db.query<{ id: string }>(`INSERT INTO users (name) VALUES ($1) RETURNING id`, [`e2e-onboarding-admin-user-${suffix}`]);
    await roles.assignToUser(adminUser.id, adminRole.id);
    const adminApiKey = `mtg_e2e_onboarding_admin_${suffix}`;
    await db.query(`INSERT INTO identities (user_id, name, api_key_hash) VALUES ($1, $2, $3)`, [
      adminUser.id,
      `e2e-onboarding-admin-identity-${suffix}`,
      hashApiKey(adminApiKey),
    ]);

    let httpServer: ChildProcess | undefined;
    try {
      httpServer = spawnHttpServer();
      const baseUrl = `http://127.0.0.1:${HTTP_PORT}`;
      await waitForHealthy(baseUrl, 15_000);

      // Step 1: the admin issues a real invitation token — create_invitation is HTTP-mode
      // only (see AdminToolHandler's own check), so this goes through a real login +
      // real MCP-over-HTTP session, not stdio.
      const adminSessionToken = await loginOverHttp(adminApiKey, baseUrl);
      const adminClient = await connectHttp(adminSessionToken, baseUrl);
      let invitationToken: string;
      try {
        const result = await adminClient.callTool({
          name: "manage_roles",
          arguments: { action: "create_invitation", roleName: basicRole.name, ttlHours: 1 },
        });
        const text = (result.content as { text: string }[])[0].text;
        const match = text.match(/mtgi_[A-Za-z0-9_-]+/);
        assert.ok(match, `expected create_invitation's response to contain a real token: ${text}`);
        invitationToken = match![0];
      } finally {
        await adminClient.close();
      }

      // Step 2: a brand new person, with NO identity/API key at all, redeems it over real
      // HTTP against the same real built httpServer.js.
      const newPersonName = `e2e-onboarding-newbie-${suffix}`;
      const redeemResponse = await fetch(`${baseUrl}/redeem-invitation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: invitationToken, name: newPersonName }),
      });
      const redeemBody = (await redeemResponse.json()) as { apiKey?: string; error?: string };
      assert.equal(redeemResponse.status, 201, `expected a successful redemption, got ${redeemResponse.status}: ${JSON.stringify(redeemBody)}`);
      const newApiKey = redeemBody.apiKey!;
      assert.match(newApiKey, /^mtg_/);

      // Redeeming the same token again must fail — it's one-time use.
      const secondAttempt = await fetch(`${baseUrl}/redeem-invitation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: invitationToken, name: `${newPersonName}-again` }),
      });
      assert.equal(secondAttempt.status, 400, "a second redemption of the same token must be rejected");

      // Step 3: the new API key actually works, over a real stdio session against the
      // same database, and resolves to exactly the role the invitation granted.
      const newPersonClient = await connectStdio(newApiKey);
      try {
        const services = await newPersonClient.callTool({ name: "list_services", arguments: {} });
        assert.doesNotMatch((services.content as { text: string }[])[0].text, /error/i);
      } finally {
        await newPersonClient.close();
      }

      // A fresh admin session confirms the real database state — a new user, holding
      // exactly the role the invitation granted, resolvable independently of whatever
      // the redemption endpoint itself returned.
      const verifyingAdminClient = await connectStdio(adminApiKey);
      try {
        const listResult = await verifyingAdminClient.callTool({ name: "manage_roles", arguments: { action: "list_users" } });
        const users = JSON.parse((listResult.content as { text: string }[])[0].text) as { name: string; roles: string[] }[];
        const newEntry = users.find((u) => u.name === newPersonName);
        assert.ok(newEntry, "the newly self-registered user must appear in list_users");
        assert.deepEqual(newEntry!.roles, [basicRole.name]);
      } finally {
        await verifyingAdminClient.close();
      }
    } finally {
      httpServer?.kill();
      await db.query(`DELETE FROM roles WHERE name LIKE $1`, [`e2e-onboarding-%-${suffix}`]);
      await db.query(`DELETE FROM users WHERE name LIKE $1`, [`e2e-onboarding-%-${suffix}`]);
      await db.end();
    }
  },
);
