import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryRelayAgentRegistry } from "./InMemoryRelayAgentRegistry.js";
import type { AgentConnection } from "./InMemoryRelayAgentRegistry.js";

/** A fake agent that immediately replies to whatever it's sent, echoing back a
 *  `respond` function's answer — lets each test control exactly what the "agent" says
 *  without a real socket. */
class FakeAgentConnection implements AgentConnection {
  private messageHandler: ((data: string) => void) | undefined;
  private closeHandler: (() => void) | undefined;
  public readonly sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  /** Test helper: simulates the agent sending a message back. */
  simulateMessage(message: unknown): void {
    this.messageHandler?.(JSON.stringify(message));
  }
  simulateClose(): void {
    this.closeHandler?.();
  }
}

test("hasConnectedAgent is false until an agent registers", () => {
  const registry = new InMemoryRelayAgentRegistry();
  assert.equal(registry.hasConnectedAgent(), false);

  registry.registerAgent(new FakeAgentConnection());
  assert.equal(registry.hasConnectedAgent(), true);
});

test("dispatch rejects immediately if no agent is connected", async () => {
  const registry = new InMemoryRelayAgentRegistry();

  await assert.rejects(() => registry.dispatch({ type: "listTools", requestId: "", connectionId: "c1" }), /No relay agent/);
});

test("dispatch resolves with the agent's response, correlated by requestId", async () => {
  const registry = new InMemoryRelayAgentRegistry();
  const agent = new FakeAgentConnection();
  registry.registerAgent(agent);

  const dispatchPromise = registry.dispatch({ type: "connect", requestId: "", command: "node", args: [], env: {} });
  const sentRequest = agent.sent[0] as { requestId: string };
  agent.simulateMessage({ type: "connected", requestId: sentRequest.requestId, connectionId: "conn-1" });

  const response = await dispatchPromise;
  assert.deepEqual(response, { type: "connected", requestId: sentRequest.requestId, connectionId: "conn-1" });
});

test("dispatch rejects when the agent responds with an error", async () => {
  const registry = new InMemoryRelayAgentRegistry();
  const agent = new FakeAgentConnection();
  registry.registerAgent(agent);

  const dispatchPromise = registry.dispatch({ type: "listTools", requestId: "", connectionId: "conn-1" });
  const sentRequest = agent.sent[0] as { requestId: string };
  agent.simulateMessage({ type: "error", requestId: sentRequest.requestId, message: "the server crashed" });

  await assert.rejects(dispatchPromise, /the server crashed/);
});

test("a response for an unknown/stale requestId is ignored rather than throwing", () => {
  const registry = new InMemoryRelayAgentRegistry();
  const agent = new FakeAgentConnection();
  registry.registerAgent(agent);

  assert.doesNotThrow(() => agent.simulateMessage({ type: "result", requestId: "never-asked-for-this", result: {} }));
});

test("when the agent disconnects, every pending dispatch is rejected instead of hanging forever", async () => {
  const registry = new InMemoryRelayAgentRegistry();
  const agent = new FakeAgentConnection();
  registry.registerAgent(agent);

  const dispatchPromise = registry.dispatch({ type: "listTools", requestId: "", connectionId: "conn-1" });
  agent.simulateClose();

  await assert.rejects(dispatchPromise, /disconnected/);
  assert.equal(registry.hasConnectedAgent(), false);
});
