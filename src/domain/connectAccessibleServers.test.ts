import assert from "node:assert/strict";
import { test } from "node:test";
import type { EncryptedUpstreamCredential, UpstreamServer } from "./types.js";
import type { UserCredentialRepository } from "../ports/UserCredentialRepository.js";
import { connectAccessibleServers } from "./connectAccessibleServers.js";
import type { ConnectedUpstream, UpstreamConnectionProvider } from "../ports/UpstreamConnectionProvider.js";

class NullUserCredentialRepository implements UserCredentialRepository {
  async find(): Promise<EncryptedUpstreamCredential | null> {
    return null;
  }
  async upsert(): Promise<void> {}
  async remove(): Promise<void> {}
}

function server(name: string): UpstreamServer {
  return { id: `server-${name}`, name, command: "irrelevant", args: [], requiresRelay: false };
}

function fakeConnected(): ConnectedUpstream {
  return { client: { listTools: async () => ({}), callTool: async () => ({ content: [] }) }, close: async () => {} };
}

test("connects to every server when all of them succeed", async () => {
  const provider: UpstreamConnectionProvider = { connect: async () => fakeConnected() };

  const connected = await connectAccessibleServers([server("a"), server("b")], "user-1", new NullUserCredentialRepository(), provider);

  assert.deepEqual(
    connected.map((c) => c.server.name),
    ["a", "b"],
  );
});

test("a server that fails to connect is skipped, but every other server still connects", async () => {
  const provider: UpstreamConnectionProvider = {
    connect: async (srv) => {
      if (srv.name === "broken") throw new Error("Missing required env var");
      return fakeConnected();
    },
  };

  const connected = await connectAccessibleServers(
    [server("working-a"), server("broken"), server("working-b")],
    "user-1",
    new NullUserCredentialRepository(),
    provider,
  );

  assert.deepEqual(
    connected.map((c) => c.server.name),
    ["working-a", "working-b"],
    "the broken server must be skipped without preventing the working ones from connecting",
  );
});

test("every failure is reported via onConnectionFailed, with the real error", async () => {
  const provider: UpstreamConnectionProvider = {
    connect: async (srv) => {
      if (srv.name === "broken") throw new Error("boom");
      return fakeConnected();
    },
  };
  const failures: { name: string; error: unknown }[] = [];

  await connectAccessibleServers([server("fine"), server("broken")], "user-1", new NullUserCredentialRepository(), provider, (srv, error) =>
    failures.push({ name: srv.name, error }),
  );

  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, "broken");
  assert.match((failures[0].error as Error).message, /boom/);
});

test("returns an empty list, without throwing, if every server fails to connect", async () => {
  const provider: UpstreamConnectionProvider = { connect: async () => Promise.reject(new Error("always fails")) };

  const connected = await connectAccessibleServers([server("a"), server("b")], "user-1", new NullUserCredentialRepository(), provider, () => {});

  assert.deepEqual(connected, []);
});
