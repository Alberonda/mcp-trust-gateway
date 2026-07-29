import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Manual demonstration of Phase 2's Claim A end to end, against two real filesystem MCP
 *  servers. Run scripts/seed_phase2_demo.ts first and pass its two printed keys here via
 *  NARROW_API_KEY / BROAD_API_KEY. See DESIGN.md's Phase 2 verification plan. */

async function connectAs(apiKey: string): Promise<Client> {
  const client = new Client({ name: "manual-test-client", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env: { ...process.env, GATEWAY_API_KEY: apiKey },
    }),
  );
  return client;
}

function toolNamesOf(result: unknown): string[] {
  return ((result as { tools?: { name: string }[] }).tools ?? []).map((t) => t.name);
}

async function main(): Promise<void> {
  const narrowKey = process.env.NARROW_API_KEY!;
  const broadKey = process.env.BROAD_API_KEY!;

  console.log("=== narrow-agent (sandbox-a only) ===");
  const narrow = await connectAs(narrowKey);

  const narrowTools = await narrow.listTools();
  console.log("tools/list:", toolNamesOf(narrowTools), "(should be exactly find_tool, call_tool)");

  const narrowDiscovery = await narrow.callTool({ name: "find_tool", arguments: { query: "" } });
  console.log("find_tool(''):", (narrowDiscovery.content as { text: string }[])[0].text);

  const narrowRead = await narrow.callTool({
    name: "call_tool",
    arguments: { server: "sandbox-a", tool: "read_text_file", arguments: { path: "/tmp/mcp-test-sandbox-a/hello-a.txt" } },
  });
  console.log("call_tool(sandbox-a, read_text_file):", (narrowRead.content as { text: string }[])[0].text.trim());

  const narrowDenied = await narrow.callTool({
    name: "call_tool",
    arguments: { server: "sandbox-b", tool: "read_text_file", arguments: { path: "/tmp/mcp-test-sandbox-b/hello-b.txt" } },
  });
  console.log(
    "call_tool(sandbox-b, ...) from narrow-agent (must be denied):",
    (narrowDenied.content as { text: string }[])[0].text,
  );

  await narrow.close();

  console.log("\n=== broad-agent (sandbox-a + sandbox-b) ===");
  const broad = await connectAs(broadKey);

  const broadDiscovery = await broad.callTool({ name: "find_tool", arguments: { query: "" } });
  const discovered = JSON.parse((broadDiscovery.content as { text: string }[])[0].text) as { server: string }[];
  console.log(
    "find_tool('') servers seen:",
    [...new Set(discovered.map((d) => d.server))],
    "(should include both sandbox-a and sandbox-b)",
  );

  const broadReadB = await broad.callTool({
    name: "call_tool",
    arguments: { server: "sandbox-b", tool: "read_text_file", arguments: { path: "/tmp/mcp-test-sandbox-b/hello-b.txt" } },
  });
  console.log("call_tool(sandbox-b, read_text_file) as broad-agent:", (broadReadB.content as { text: string }[])[0].text.trim());

  await broad.close();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
