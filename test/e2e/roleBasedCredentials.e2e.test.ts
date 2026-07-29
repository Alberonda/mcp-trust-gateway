import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import pg from "pg";
import { PostgresRoleRepository } from "../../src/adapters/postgres/RoleRepository.js";
import { AesGcmCredentialVault } from "../../src/adapters/security/CredentialVault.js";

/**
 * A genuine end-to-end test: spawns the REAL built gateway (dist/entrypoints/stdio/index.js) as a real
 * subprocess, drives it over the real MCP protocol, and — critically — verifies the
 * result by querying Postgres DIRECTLY with raw SQL afterward, completely independent of
 * the application code under test. This is deliberately NOT a repository-level test with
 * fakes (see the *.test.ts files next to each class for that); it exists specifically to
 * answer "does a real credential submitted through a real session actually end up
 * correctly encrypted in the real table," which no unit test can prove by itself.
 *
 * Requires TEST_DATABASE_URL, GATEWAY_ENCRYPTION_KEY, and a built dist/entrypoints/stdio/index.js (run
 * `npm run build` first) — see package.json's "test:e2e" script.
 *
 * The three "developer" servers here are named jira/sonarqube/jenkins to mirror
 * scripts/seed_default_roles.ts's real setup, but are backed by the official, dependency-free
 * memory reference server rather than the real wrappers — this test verifies OUR credential
 * storage plumbing, not any third-party service's behavior, and needs to run hermetically
 * (no live Jenkins/Jira/SonarQube credentials, no flaky external network calls) every time.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. This is an end-to-end test — it needs a real, migrated Postgres ` +
        `(TEST_DATABASE_URL) and the real GATEWAY_ENCRYPTION_KEY, plus a built dist/entrypoints/stdio/index.js ` +
        `(npm run build). See package.json's "test:e2e" script.`,
    );
  }
  return value;
}

const testDatabaseUrl = requireEnv("TEST_DATABASE_URL");
const encryptionKey = Buffer.from(requireEnv("GATEWAY_ENCRYPTION_KEY"), "hex");
const vault = new AesGcmCredentialVault(encryptionKey);

const DEVELOPER_SERVER_NAMES = ["jira", "sonarqube", "jenkins"] as const;

interface TestFixture {
  readonly db: pg.Client;
  readonly suffix: string;
  readonly adminApiKey: string;
  readonly developerApiKey: string;
  readonly developerUserId: string;
  readonly developerRoleId: string;
  readonly serverIdsByName: ReadonlyMap<string, string>;
}

/** Builds one admin + one developer (with real, committed rows — a real subprocess in a
 *  different connection needs to actually see this data, so a rolled-back transaction
 *  like the integration tests use won't work here) and tears it all down afterward
 *  regardless of pass/fail, via the caller's try/finally. */
async function setupFixture(): Promise<TestFixture> {
  const db = new pg.Client({ connectionString: testDatabaseUrl });
  await db.connect();
  const suffix = randomUUID().slice(0, 8);
  const roles = new PostgresRoleRepository(db);

  const adminRole = await roles.create(`e2e-admin-${suffix}`, true);
  const developerRole = await roles.create(`e2e-developer-${suffix}`, false);

  const {
    rows: [adminUser],
  } = await db.query<{ id: string }>(`INSERT INTO users (name) VALUES ($1) RETURNING id`, [`e2e-admin-user-${suffix}`]);
  const {
    rows: [developerUser],
  } = await db.query<{ id: string }>(`INSERT INTO users (name) VALUES ($1) RETURNING id`, [`e2e-developer-user-${suffix}`]);

  await roles.assignToUser(adminUser.id, adminRole.id);
  await roles.assignToUser(developerUser.id, developerRole.id);

  const adminApiKey = `mtg_e2e_admin_${suffix}`;
  const developerApiKey = `mtg_e2e_developer_${suffix}`;
  const { hashApiKey } = await import("../../src/adapters/security/apiKeys.js");
  await db.query(`INSERT INTO identities (user_id, name, api_key_hash) VALUES ($1, $2, $3)`, [
    adminUser.id,
    `e2e-admin-identity-${suffix}`,
    hashApiKey(adminApiKey),
  ]);
  await db.query(`INSERT INTO identities (user_id, name, api_key_hash) VALUES ($1, $2, $3)`, [
    developerUser.id,
    `e2e-developer-identity-${suffix}`,
    hashApiKey(developerApiKey),
  ]);

  const serverIdsByName = new Map<string, string>();
  for (const name of DEVELOPER_SERVER_NAMES) {
    const serverName = `${name}-${suffix}`;
    const {
      rows: [server],
    } = await db.query<{ id: string }>(
      `INSERT INTO upstream_servers (name, command, args) VALUES ($1, $2, $3) RETURNING id`,
      [serverName, "npx", JSON.stringify(["-y", "@modelcontextprotocol/server-memory"])],
    );
    serverIdsByName.set(name, server.id);
    await db.query(`INSERT INTO permissions (role_id, server_id, tool_name) VALUES ($1, $2, NULL)`, [developerRole.id, server.id]);
  }

  return { db, suffix, adminApiKey, developerApiKey, developerUserId: developerUser.id, developerRoleId: developerRole.id, serverIdsByName };
}

async function teardownFixture(fixture: TestFixture): Promise<void> {
  // Deleting the roles cascades to user_roles/permissions; deleting the users cascades to
  // identities/user_roles/user_credentials (see migrations' ON DELETE CASCADE foreign keys).
  await fixture.db.query(`DELETE FROM roles WHERE name LIKE $1`, [`e2e-%-${fixture.suffix}`]);
  await fixture.db.query(`DELETE FROM users WHERE name LIKE $1`, [`e2e-%-${fixture.suffix}`]);
  await fixture.db.query(`DELETE FROM upstream_servers WHERE name LIKE $1`, [`%-${fixture.suffix}`]);
  await fixture.db.end();
}

function connectAsGatewayClient(apiKey: string): Promise<Client> {
  const client = new Client({ name: "e2e-test", version: "0.0.1" });
  return client
    .connect(
      new StdioClientTransport({
        command: "node",
        args: ["dist/entrypoints/stdio/index.js"],
        env: {
          ...process.env,
          GATEWAY_API_KEY: apiKey,
          DATABASE_URL: testDatabaseUrl,
          GATEWAY_ENCRYPTION_KEY: process.env.GATEWAY_ENCRYPTION_KEY!,
        },
      }),
    )
    .then(() => client);
}

test(
  "a developer's real self-registered credential ends up correctly encrypted in Postgres, decryptable back to the exact original value",
  { timeout: 60_000 },
  async () => {
    const fixture = await setupFixture();
    try {
      const gatewayClient = await connectAsGatewayClient(fixture.developerApiKey);
      try {
        const submittedEnvByServer: Record<string, Record<string, string>> = {
          jira: { JIRA_API_TOKEN: `jira-secret-${fixture.suffix}` },
          sonarqube: { SONARQUBE_TOKEN: `sonar-secret-${fixture.suffix}` },
          jenkins: { JENKINS_API_TOKEN: `jenkins-secret-${fixture.suffix}` },
        };

        for (const [name, env] of Object.entries(submittedEnvByServer)) {
          const result = await gatewayClient.callTool({
            name: "register_my_credential",
            arguments: { server: `${name}-${fixture.suffix}`, env },
          });
          const text = (result.content as { text: string }[])[0].text;
          assert.doesNotMatch(text, /error|denied/i, `registering the ${name} credential must succeed: ${text}`);
        }

        // The whole point of this test: verify against the real table with raw SQL,
        // completely independent of UserCredentialRepository/CredentialVault's own code
        // paths in the application — this is what actually proves the round trip works,
        // not just that our own classes agree with themselves.
        for (const [name, expectedEnv] of Object.entries(submittedEnvByServer)) {
          const serverId = fixture.serverIdsByName.get(name)!;
          const {
            rows: [row],
          } = await fixture.db.query<{ encryptedCredential: Buffer; credentialIv: Buffer; credentialAuthTag: Buffer }>(
            `SELECT encrypted_credential AS "encryptedCredential", credential_iv AS "credentialIv", credential_auth_tag AS "credentialAuthTag"
             FROM user_credentials WHERE user_id = $1 AND server_id = $2`,
            [fixture.developerUserId, serverId],
          );

          assert.ok(row, `expected a user_credentials row for developer/${name}`);
          const expectedPlaintext = JSON.stringify(expectedEnv);
          assert.ok(
            !row.encryptedCredential.toString("utf8").includes(Object.values(expectedEnv)[0]),
            `the ${name} credential must never be stored in plaintext`,
          );

          const decrypted = vault.decrypt({ ciphertext: row.encryptedCredential, iv: row.credentialIv, authTag: row.credentialAuthTag });
          assert.equal(decrypted, expectedPlaintext, `decrypting the stored ${name} credential must yield exactly what was submitted`);
        }
      } finally {
        await gatewayClient.close();
      }
    } finally {
      await teardownFixture(fixture);
    }
  },
);

test(
  "an admin can see the developer and their role through manage_roles, reflecting the real database state",
  { timeout: 60_000 },
  async () => {
    const fixture = await setupFixture();
    try {
      const adminClient = await connectAsGatewayClient(fixture.adminApiKey);
      try {
        const result = await adminClient.callTool({ name: "manage_roles", arguments: { action: "list_users" } });
        const users = JSON.parse((result.content as { text: string }[])[0].text) as { name: string; roles: string[] }[];

        const developerEntry = users.find((u) => u.name === `e2e-developer-user-${fixture.suffix}`);
        assert.ok(developerEntry, "the developer user must appear in list_users");
        assert.deepEqual(developerEntry!.roles, [`e2e-developer-${fixture.suffix}`]);
      } finally {
        await adminClient.close();
      }
    } finally {
      await teardownFixture(fixture);
    }
  },
);
