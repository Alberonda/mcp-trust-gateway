// Minimal real MCP server used only by UpstreamConnectionProvider.test.ts to prove what
// env vars a spawned upstream server subprocess actually receives — a genuine subprocess
// spawn is the only way to catch a regression here; mocking StdioClientTransport would
// hide exactly the class of bug this exists to catch (see the "env isolation" test).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo-env-test", version: "0.0.1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{ name: "echo_env", description: "Returns this process's own env as JSON.", inputSchema: { type: "object" } }],
}));
server.setRequestHandler(CallToolRequestSchema, () => ({
  content: [{ type: "text", text: JSON.stringify(process.env) }],
}));
await server.connect(new StdioServerTransport());
