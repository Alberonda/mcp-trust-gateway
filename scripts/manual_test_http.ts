import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Manual end-to-end test of HTTP mode: connects like a real remote team member would,
 *  over the network with an Authorization header, against a running httpServer.ts
 *  instance. Start the server first: npm run build && npm run start:http */

async function connectAs(apiKey: string, baseUrl: string): Promise<Client> {
  const client = new Client({ name: "manual-http-test-client", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
    }),
  );
  return client;
}

async function main(): Promise<void> {
  const baseUrl = process.env.HTTP_BASE_URL ?? "http://127.0.0.1:3443/mcp";
  const narrowKey = process.env.NARROW_API_KEY!;

  console.log("=== connecting over HTTP as narrow-agent ===");
  const client = await connectAs(narrowKey, baseUrl);

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

  console.log("\n=== unauthenticated request must be rejected ===");
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  console.log(`status without Authorization header: ${res.status} (expected 401)`);

  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
