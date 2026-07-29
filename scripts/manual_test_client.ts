import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Manual end-to-end smoke test: connects to the built gateway exactly as a real
 *  agent (Devin CLI, Claude Desktop) would, lists tools, and calls one. Not a real
 *  test suite yet — that's worth adding once Phase 1 is proven to work at all. */

async function main(): Promise<void> {
  const client = new Client({ name: "manual-test-client", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env: {
        ...process.env,
        GATEWAY_API_KEY: process.env.TEST_GATEWAY_API_KEY!,
        UPSTREAM_SERVER_NAME: "filesystem",
      },
    }),
  );

  const tools = await client.listTools();
  console.log(`Tools exposed through the gateway: ${tools.tools.map((t) => t.name).join(", ")}`);

  const result = await client.callTool({
    name: "read_text_file",
    arguments: { path: "/tmp/mcp-test-sandbox/hello.txt" },
  });
  console.log("callTool result:", JSON.stringify(result, null, 2));

  // Without this, the spawned gateway process (and the filesystem server it spawns in
  // turn) outlive process.exit() here — StdioClientTransport.close() is what actually
  // kills the child process tree.
  await client.close();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
