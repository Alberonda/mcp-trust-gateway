# mcp-trust-gateway-bridge

Thin stdio-to-HTTP relay for connecting to `mcp-trust-gateway`'s HTTP mode without a local
process holding the database URL or master encryption key.

**Most MCP clients don't need this at all.** If your client supports remote HTTP servers
with a static header (Devin CLI, and most others do — see the main README's "Connecting
without a local process"), point it directly at the deployed `/mcp` URL with your session
token. This bridge exists for two narrower cases:

1. Your MCP client only supports local stdio servers.
2. You'd rather not send a long-lived `GATEWAY_API_KEY` on every single request — this
   bridge logs in once, keeps a short-lived session token fresh, and only ever sends that.

## What it holds locally

Exactly one secret: `GATEWAY_API_KEY`. Never `DATABASE_URL`, never
`GATEWAY_ENCRYPTION_KEY` — those stay exclusively on whatever server runs
`entrypoints/http/httpServer.ts`. This process has no business logic of its own: no
permission checks, no decryption, nothing an attacker with access to this process could
use to reach any other user's data.

## Usage

```json
{
  "mcpServers": {
    "trust-gateway": {
      "command": "node",
      "args": ["/path/to/mcp-trust-gateway/bridge/dist/index.js"],
      "env": {
        "GATEWAY_API_KEY": "mtg_...",
        "GATEWAY_URL": "https://mcp-trust-gateway.onrender.com"
      }
    }
  }
}
```

`GATEWAY_URL` defaults to `https://mcp-trust-gateway.onrender.com` if omitted.

## Build

```bash
npm install
npm run build
```
