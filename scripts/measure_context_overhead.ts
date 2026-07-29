import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { encode } from "gpt-tokenizer";

/**
 * Demonstrates Claim B from DESIGN.md's Phase 2 plan with a real measurement, not an
 * estimate: "the token cost of tools/list stays ~constant through the gateway, while a
 * direct multi-server connection's cost grows with every tool added." Token counts use
 * gpt-tokenizer's o200k_base encoding (GPT-4o class models) against the *exact* JSON
 * payload a tools/list response actually contains.
 *
 * Run scripts/seed_phase2_demo.ts first (registers sandbox-a/b) and pass BROAD_API_KEY.
 */

async function tokensOfDirectConnection(command: string, args: string[]): Promise<number> {
  const client = new Client({ name: "measurement-script", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command, args }));
  const result = await client.listTools();
  await client.close();
  return encode(JSON.stringify(result)).length;
}

async function tokensThroughGateway(apiKey: string): Promise<number> {
  const client = new Client({ name: "measurement-script", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({ command: "node", args: ["dist/entrypoints/stdio/index.js"], env: { ...process.env, GATEWAY_API_KEY: apiKey } }),
  );
  const result = await client.listTools();
  await client.close();
  return encode(JSON.stringify(result)).length;
}

async function main(): Promise<void> {
  const broadKey = process.env.BROAD_API_KEY!;

  const oneServerDirect = await tokensOfDirectConnection("npx", [
    "-y",
    "@modelcontextprotocol/server-filesystem",
    "/tmp/mcp-test-sandbox-a",
  ]);
  const secondServerDirect = await tokensOfDirectConnection("npx", [
    "-y",
    "@modelcontextprotocol/server-filesystem",
    "/tmp/mcp-test-sandbox-b",
  ]);
  const twoServersDirect = oneServerDirect + secondServerDirect;

  const throughGateway = await tokensThroughGateway(broadKey);

  const perServerAverage = twoServersDirect / 2;

  console.log("Measured (real MCP servers, real gpt-tokenizer o200k_base encoding):");
  console.log(`  1 server,  direct connection : ${oneServerDirect} tokens`);
  console.log(`  2 servers, direct connection : ${twoServersDirect} tokens`);
  console.log(`  2 servers, through gateway   : ${throughGateway} tokens`);
  console.log(
    `  Reduction at N=2: ${(((twoServersDirect - throughGateway) / twoServersDirect) * 100).toFixed(1)}%\n`,
  );

  console.log("Extrapolated from the measured per-server average (labeled as extrapolation, not measured):");
  for (const n of [2, 5, 10, 20]) {
    const direct = Math.round(perServerAverage * n);
    console.log(
      `  N=${String(n).padEnd(2)} servers — direct: ~${direct} tokens vs gateway: ${throughGateway} tokens ` +
        `(${(((direct - throughGateway) / direct) * 100).toFixed(0)}% reduction)`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
