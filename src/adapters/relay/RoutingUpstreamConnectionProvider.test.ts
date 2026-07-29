import assert from "node:assert/strict";
import { test } from "node:test";
import type { EncryptedUpstreamCredential, UpstreamServer } from "../../domain/types.js";
import type { ConnectedUpstream, UpstreamConnectionProvider } from "../../ports/UpstreamConnectionProvider.js";
import { RoutingUpstreamConnectionProvider } from "./RoutingUpstreamConnectionProvider.js";

function fakeProvider(label: string): { provider: UpstreamConnectionProvider; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      connect: async (server: UpstreamServer) => {
        calls.push(server.name);
        return { client: { listTools: async () => ({}), callTool: async () => ({ content: [] }) }, close: async () => {} } as ConnectedUpstream;
      },
    },
  };
}

function server(name: string, requiresRelay: boolean): UpstreamServer {
  return { id: `id-${name}`, name, command: "irrelevant", args: [], requiresRelay };
}

test("routes a server with requiresRelay=false to the local provider", async () => {
  const local = fakeProvider("local");
  const relay = fakeProvider("relay");
  const router = new RoutingUpstreamConnectionProvider(local.provider, relay.provider);

  await router.connect(server("sandbox", false), null);

  assert.deepEqual(local.calls, ["sandbox"]);
  assert.deepEqual(relay.calls, []);
});

test("routes a server with requiresRelay=true to the relay provider", async () => {
  const local = fakeProvider("local");
  const relay = fakeProvider("relay");
  const router = new RoutingUpstreamConnectionProvider(local.provider, relay.provider);

  await router.connect(server("sonarqube", true), null);

  assert.deepEqual(local.calls, []);
  assert.deepEqual(relay.calls, ["sonarqube"]);
});

test("passes the credential through unchanged to whichever provider it routes to", async () => {
  let receivedCredential: EncryptedUpstreamCredential | null = null;
  const relay: UpstreamConnectionProvider = {
    connect: async (_server, credential) => {
      receivedCredential = credential;
      return { client: { listTools: async () => ({}), callTool: async () => ({ content: [] }) }, close: async () => {} };
    },
  };
  const router = new RoutingUpstreamConnectionProvider(fakeProvider("local").provider, relay);
  const credential: EncryptedUpstreamCredential = { ciphertext: Buffer.from("c"), iv: Buffer.from("i"), authTag: Buffer.from("a") };

  await router.connect(server("sonarqube", true), credential);

  assert.equal(receivedCredential, credential);
});
