import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Manual end-to-end smoke test: connects to the built gateway exactly as a real agent
 *  (Devin CLI, Claude Desktop) would, lists tools (Phase 2: expects exactly the two
 *  meta-tools, not the real filesystem tools directly), discovers a real tool via
 *  find_tool, then calls it via call_tool. See scripts/manual_test_phase2.ts for the
 *  multi-server/cross-permission version of this same idea (Claim A's demonstration). */

async function main(): Promise<void> {
  const client = new Client({ name: "manual-test-client", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: ["dist/entrypoints/stdio/index.js"],
      env: { ...process.env, GATEWAY_API_KEY: process.env.TEST_GATEWAY_API_KEY! },
    }),
  );

  const tools = await client.listTools();
  console.log(`Tools exposed through the gateway: ${tools.tools.map((t) => t.name).join(", ")}`);

  const discovery = await client.callTool({ name: "find_tool", arguments: { query: "read_text_file" } });
  console.log("find_tool result:", (discovery.content as { text: string }[])[0].text);

  const result = await client.callTool({
    name: "call_tool",
    arguments: {
      server: "filesystem",
      tool: "read_text_file",
      arguments: { path: "/tmp/mcp-test-sandbox/hello.txt" },
    },
  });
  console.log("call_tool result:", JSON.stringify(result, null, 2));

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
