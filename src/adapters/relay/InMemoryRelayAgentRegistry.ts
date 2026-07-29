import { randomUUID } from "node:crypto";
import type {
  RelayAgentRegistry,
  RelayConnectedResponse,
  RelayRequest,
  RelayResponse,
  RelayResultResponse,
} from "../../ports/RelayAgentRegistry.js";

const DISPATCH_TIMEOUT_MS = 30_000;

/** The minimal slice of a real WebSocket connection this registry needs — kept separate
 *  from the `ws` library's own type so this class (and its tests) don't depend on it
 *  directly. entrypoints/http/httpServer.ts adapts a real `ws` connection to this shape. */
export interface AgentConnection {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
}

interface PendingDispatch {
  resolve(response: RelayConnectedResponse | RelayResultResponse): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

/**
 * Holds exactly one connected relay agent at a time (a real deployment would want one
 * agent per network the gateway itself can't reach, potentially several — see DESIGN.md's
 * backlog; this is the smallest version that's still genuinely useful, not a permanent
 * design constraint). Matches requests to responses by `requestId`, generated fresh here
 * so callers never need to invent their own correlation scheme.
 */
export class InMemoryRelayAgentRegistry implements RelayAgentRegistry {
  private connection: AgentConnection | undefined;
  private readonly pending = new Map<string, PendingDispatch>();

  registerAgent(connection: AgentConnection): void {
    this.connection = connection;
    connection.onMessage((data) => this.handleMessage(data));
    connection.onClose(() => {
      if (this.connection === connection) this.connection = undefined;
      this.rejectAllPending(new Error("The relay agent disconnected before responding."));
    });
  }

  hasConnectedAgent(): boolean {
    return this.connection !== undefined;
  }

  dispatch(request: RelayRequest): Promise<RelayConnectedResponse | RelayResultResponse> {
    const connection = this.connection;
    if (!connection) {
      return Promise.reject(new Error("No relay agent is currently connected — this server can only be reached through one."));
    }

    const requestId = randomUUID();
    const requestWithId = { ...request, requestId };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Relay agent did not respond within ${DISPATCH_TIMEOUT_MS}ms.`));
      }, DISPATCH_TIMEOUT_MS);

      this.pending.set(requestId, { resolve, reject, timeout });
      connection.send(JSON.stringify(requestWithId));
    });
  }

  private handleMessage(data: string): void {
    let response: RelayResponse;
    try {
      response = JSON.parse(data) as RelayResponse;
    } catch {
      return; // Not a well-formed relay message — nothing to correlate it to.
    }

    const pending = this.pending.get(response.requestId);
    if (!pending) return; // Already timed out, or a stray/duplicate response.
    this.pending.delete(response.requestId);
    clearTimeout(pending.timeout);

    if (response.type === "error") {
      pending.reject(new Error(response.message));
    } else {
      pending.resolve(response);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const { reject, timeout } of this.pending.values()) {
      clearTimeout(timeout);
      reject(error);
    }
    this.pending.clear();
  }
}
