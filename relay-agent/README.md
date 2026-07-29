# mcp-trust-gateway-relay-agent

Executes real MCP server subprocesses on behalf of a remote `mcp-trust-gateway`
deployment, for servers only reachable from *this* machine's network — an internal
SonarQube/Jenkins instance, say. A subprocess spawning without crashing only proves the
binary starts, not that the network call it will eventually make can succeed; if your
gateway runs somewhere without a route to that network, this is the piece that's missing.

**Do you need this?** Only if you've marked a server `requires_relay = true` and the
machine running your gateway (e.g. a public cloud host) can't itself reach it. If every
server your gateway needs is reachable from wherever the gateway itself runs, you don't
need this at all — see the main README's "Relay agent" section for that distinction.

## What it holds locally

Exactly one secret: `GATEWAY_API_KEY` — a real, revocable credential, the same kind any
other client of the gateway uses. Never the database URL, never the master encryption
key, never a stored credential's ciphertext. The gateway decrypts a server's credential
itself and sends this process only the already-decrypted env for one active connection,
at the moment it's needed — this process never touches Postgres and forgets that env the
moment the connection closes.

## How it connects

Opens a WebSocket *outbound* to the gateway's `/agent` endpoint — nothing needs an
inbound port open on this machine or its network. From then on, the gateway sends
`connect`/`listTools`/`callTool`/`close` requests and this process executes them,
spawning the real subprocess with the same safe, allowlist-based environment
(`getDefaultEnvironment()` plus only the env it was sent) the gateway's own local
execution path uses — this process's own environment, including `GATEWAY_API_KEY`, never
reaches a spawned server either.

## Usage

```bash
npm install && npm run build
GATEWAY_API_KEY=mtg_... GATEWAY_URL=https://your-gateway-host node dist/index.js
```

Reconnects automatically (5s delay) if the connection drops.
