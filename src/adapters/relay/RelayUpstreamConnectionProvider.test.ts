import assert from "node:assert/strict";
import { test } from "node:test";
import type { UpstreamServer } from "../../domain/types.js";
import type { RelayAgentRegistry, RelayConnectedResponse, RelayRequest, RelayResultResponse } from "../../ports/RelayAgentRegistry.js";
import { AesGcmCredentialVault } from "../security/CredentialVault.js";
import { RelayUpstreamConnectionProvider } from "./RelayUpstreamConnectionProvider.js";

const vault = new AesGcmCredentialVault(Buffer.alloc(32, 1));
const server: UpstreamServer = { id: "s1", name: "sonarqube", command: "npx", args: ["-y", "sonarqube-server-mcp"], requiresRelay: true };

/** Records every request it was asked to dispatch and returns whatever `responses` gives
 *  back next, in order — enough to drive a full connect -> listTools -> callTool -> close
 *  sequence without a real agent or socket. */
class FakeRelayAgentRegistry implements RelayAgentRegistry {
  public readonly requests: RelayRequest[] = [];
  constructor(private readonly responses: (RelayConnectedResponse | RelayResultResponse)[]) {}

  hasConnectedAgent(): boolean {
    return true;
  }

  async dispatch(request: RelayRequest): Promise<RelayConnectedResponse | RelayResultResponse> {
    this.requests.push(request);
    const response = this.responses[this.requests.length - 1];
    if (!response) throw new Error("FakeRelayAgentRegistry ran out of scripted responses.");
    return response;
  }
}

test("connect() sends the server's command/args and the DECRYPTED env, never the ciphertext", async () => {
  const registry = new FakeRelayAgentRegistry([{ type: "connected", requestId: "r1", connectionId: "conn-1" }]);
  const provider = new RelayUpstreamConnectionProvider(registry, vault);
  const credential = vault.encrypt(JSON.stringify({ SONARQUBE_TOKEN: "real-secret-value" }));

  await provider.connect(server, credential);

  const sent = registry.requests[0];
  assert.equal(sent.type, "connect");
  assert.deepEqual((sent as { command: string }).command, "npx");
  assert.deepEqual((sent as { env: Record<string, string> }).env, { SONARQUBE_TOKEN: "real-secret-value" });
});

test("connect() with no credential sends an empty env instead of throwing", async () => {
  const registry = new FakeRelayAgentRegistry([{ type: "connected", requestId: "r1", connectionId: "conn-1" }]);
  const provider = new RelayUpstreamConnectionProvider(registry, vault);

  await provider.connect(server, null);

  assert.deepEqual((registry.requests[0] as { env: Record<string, string> }).env, {});
});

test("the returned client's listTools/callTool/close dispatch against the SAME connectionId returned by connect", async () => {
  const registry = new FakeRelayAgentRegistry([
    { type: "connected", requestId: "r1", connectionId: "conn-1" },
    { type: "result", requestId: "r2", result: { tools: [{ name: "jira_search" }] } },
    { type: "result", requestId: "r3", result: { content: [{ type: "text", text: "done" }] } },
    { type: "result", requestId: "r4", result: null },
  ]);
  const provider = new RelayUpstreamConnectionProvider(registry, vault);

  const connected = await provider.connect(server, null);
  const tools = await connected.client.listTools();
  const callResult = await connected.client.callTool("jira_search", { jql: "project = TEST" });
  await connected.close();

  assert.deepEqual(tools, { tools: [{ name: "jira_search" }] });
  assert.deepEqual(callResult, { content: [{ type: "text", text: "done" }] });

  for (const request of registry.requests.slice(1)) {
    assert.equal((request as { connectionId: string }).connectionId, "conn-1");
  }
  assert.equal(registry.requests[1].type, "listTools");
  assert.equal(registry.requests[2].type, "callTool");
  assert.equal((registry.requests[2] as { toolName: string }).toolName, "jira_search");
  assert.equal(registry.requests[3].type, "close");
});

test("a stored credential that doesn't decrypt to valid JSON fails clearly, same as the local provider", async () => {
  const registry = new FakeRelayAgentRegistry([]);
  const provider = new RelayUpstreamConnectionProvider(registry, vault);
  const notJson = vault.encrypt("this is not json");

  await assert.rejects(() => provider.connect(server, notJson), /not valid JSON/);
});

test("dispatch() failing (e.g. no agent connected) propagates as a real rejection", async () => {
  const registry: RelayAgentRegistry = {
    hasConnectedAgent: () => false,
    dispatch: () => Promise.reject(new Error("No relay agent is currently connected")),
  };
  const provider = new RelayUpstreamConnectionProvider(registry, vault);

  await assert.rejects(() => provider.connect(server, null), /No relay agent/);
});
