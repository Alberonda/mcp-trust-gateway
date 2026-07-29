/**
 * The wire protocol between the gateway and a connected relay agent (see
 * adapters/relay/ for the gateway side, relay-agent/ for the standalone package that runs
 * this on the operator's own machine). Deliberately NOT the MCP protocol itself — the
 * *direction* of control is inverted from a normal MCP client/server relationship (the
 * gateway, not the agent, initiates every request), which is why this needed its own,
 * much smaller protocol instead of reusing MCP's request/response shape as-is.
 *
 * Every message the gateway sends the agent already carries a *decrypted* env — the
 * agent never holds the master key, never talks to Postgres, and never decides
 * permissions; it only ever executes exactly what it's told, once told.
 */

export interface RelayConnectRequest {
  readonly type: "connect";
  readonly requestId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface RelayListToolsRequest {
  readonly type: "listTools";
  readonly requestId: string;
  readonly connectionId: string;
}

export interface RelayCallToolRequest {
  readonly type: "callTool";
  readonly requestId: string;
  readonly connectionId: string;
  readonly toolName: string;
  readonly arguments: unknown;
}

export interface RelayCloseRequest {
  readonly type: "close";
  readonly requestId: string;
  readonly connectionId: string;
}

export type RelayRequest = RelayConnectRequest | RelayListToolsRequest | RelayCallToolRequest | RelayCloseRequest;

export interface RelayConnectedResponse {
  readonly type: "connected";
  readonly requestId: string;
  readonly connectionId: string;
}

export interface RelayResultResponse {
  readonly type: "result";
  readonly requestId: string;
  readonly result: unknown;
}

export interface RelayErrorResponse {
  readonly type: "error";
  readonly requestId: string;
  readonly message: string;
}

export type RelayResponse = RelayConnectedResponse | RelayResultResponse | RelayErrorResponse;

/**
 * Tracks whichever relay agent(s) are currently connected and lets the gateway send one a
 * request and await its matching response — the mechanics of "there's a live socket
 * somewhere, correlate requests with responses on it" separated from what actually gets
 * sent (see RelayUpstreamConnectionProvider, the only real caller).
 */
export interface RelayAgentRegistry {
  /** True if there's a connected agent able to take a request right now. */
  hasConnectedAgent(): boolean;

  /** Sends `request` to a connected agent and resolves with its matching response.
   *  Rejects if no agent is connected, or if the agent's response is itself a
   *  RelayErrorResponse. */
  dispatch(request: RelayRequest): Promise<RelayConnectedResponse | RelayResultResponse>;
}
