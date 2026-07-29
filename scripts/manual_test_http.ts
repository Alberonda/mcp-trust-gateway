import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Manual end-to-end test of HTTP mode: logs in with a long-lived API key to get a
 *  short-lived session token (Phase 3b), then connects to /mcp with that session token —
 *  exactly like a real remote team member would. Start the server first:
 *  npm run build && npm run start:http */

async function login(apiKey: string, baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const { token } = (await res.json()) as { token: string };
  return token;
}

async function connectWithSessionToken(sessionToken: string, baseUrl: string): Promise<Client> {
  const client = new Client({ name: "manual-http-test-client", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${sessionToken}` } },
    }),
  );
  return client;
}

async function main(): Promise<void> {
  const baseUrl = process.env.HTTP_BASE_URL ?? "http://127.0.0.1:3443";
  const narrowKey = process.env.NARROW_API_KEY!;

  console.log("=== POST /login with the long-lived API key ===");
  const sessionToken = await login(narrowKey, baseUrl);
  console.log("Got session token:", sessionToken.slice(0, 12) + "...");

  console.log("\n=== connecting to /mcp with the session token (not the API key) ===");
  const client = await connectWithSessionToken(sessionToken, baseUrl);

  const tools = await client.listTools();
  console.log("tools/list:", tools.tools.map((t) => t.name));

  const discovery = await client.callTool({ name: "find_tool", arguments: { query: "read_text_file" } });
  console.log("find_tool:", (discovery.content as { text: string }[])[0].text);

  const result = await client.callTool({
    name: "call_tool",
    arguments: {
      server: "sandbox-a",
      tool: "read_text_file",
      arguments: { path: "/tmp/mcp-test-sandbox-a/hello-a.txt" },
    },
  });
  console.log("call_tool result:", (result.content as { text: string }[])[0].text.trim());

  console.log("\n=== unauthenticated request to /mcp must be rejected ===");
  const unauth = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  console.log(`status without Authorization header: ${unauth.status} (expected 401)`);

  console.log("\n=== the raw API key must NOT work directly against /mcp anymore ===");
  const rawKeyAttempt = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${narrowKey}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  console.log(`status using the raw API key against /mcp: ${rawKeyAttempt.status} (expected 401 — must log in first)`);

  console.log("\n=== POST /logout revokes the session ===");
  await client.close();
  await fetch(`${baseUrl}/logout`, { method: "POST", headers: { Authorization: `Bearer ${sessionToken}` } });
  const afterLogout = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  console.log(`status reusing a revoked session token: ${afterLogout.status} (expected 401)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
