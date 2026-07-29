import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { UpstreamServer } from "../../domain/types.js";
import { AesGcmCredentialVault } from "../security/CredentialVault.js";
import { PerSessionUpstreamConnectionProvider } from "./UpstreamConnectionProvider.js";

/**
 * Regression test for a real vulnerability found 2026-07-29 (see DESIGN.md): the
 * connection provider used to spawn every upstream server subprocess with
 * `{ ...process.env, ...decryptedEnv }`, handing it the *gateway's own* secrets
 * (GATEWAY_ENCRYPTION_KEY, DATABASE_URL, ...) in addition to its own — meaning a
 * malicious or supply-chain-compromised upstream MCP server (a real risk for
 * community-published npm packages, which is exactly what triggered this investigation)
 * could exfiltrate the master key protecting every other stored credential just by
 * reading its own environment.
 *
 * This test spawns a REAL subprocess (test/fixtures/echoEnvServer.mjs) through the real
 * provider — mocking StdioClientTransport would hide exactly the class of bug this exists
 * to catch, since the bug was in *what gets passed to the real spawn call*.
 */

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "test", "fixtures", "echoEnvServer.mjs");

test("connect() never exposes the gateway process's own secrets to a spawned upstream server", async () => {
  const originalEncryptionKey = process.env.GATEWAY_ENCRYPTION_KEY;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.GATEWAY_ENCRYPTION_KEY = "should-never-reach-a-subprocess";
  process.env.DATABASE_URL = "postgres://should-never-reach-a-subprocess";

  try {
    const vault = new AesGcmCredentialVault(Buffer.alloc(32, 1));
    const provider = new PerSessionUpstreamConnectionProvider(vault);
    const server: UpstreamServer = { id: "test-server", name: "echo-env-test", command: "node", args: [FIXTURE_PATH], requiresRelay: false };
    const credential = vault.encrypt(JSON.stringify({ FAKE_UPSTREAM_TOKEN: "legitimate-value" }));

    const { client, close } = await provider.connect(server, credential);
    try {
      const result = await client.callTool("echo_env", {});
      const childEnv = JSON.parse((result.content as unknown as { text: string }[])[0].text) as Record<string, string>;

      assert.equal("GATEWAY_ENCRYPTION_KEY" in childEnv, false, "the gateway's own encryption key must never reach a subprocess");
      assert.equal("DATABASE_URL" in childEnv, false, "the gateway's own database URL must never reach a subprocess");
      assert.equal(childEnv.FAKE_UPSTREAM_TOKEN, "legitimate-value", "the server's OWN env var must still arrive correctly");
    } finally {
      await close();
    }
  } finally {
    process.env.GATEWAY_ENCRYPTION_KEY = originalEncryptionKey;
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});
