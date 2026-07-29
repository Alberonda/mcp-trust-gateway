# MCP Trust Gateway

A transparent proxy that sits between any MCP client (Devin CLI, Claude Desktop, Cursor...)
and real MCP servers, adding the trust/control plane most agent tooling is currently missing:
per-identity permissions, encrypted credential brokering, and a structured, redacted audit
log of every tool call.

See [`DESIGN.md`](./DESIGN.md) for the full motivation (validated against 2026 research on
gaps in agent tooling), architecture, and phased plan — read that first in any new session.

## Status

Phase 1 (MVP) scaffold — not yet run against a real database or a real upstream MCP server.
See `DESIGN.md`'s status log for the current state.

## Setup (once Phase 1 is wired up end to end)

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL and GATEWAY_ENCRYPTION_KEY
npm run migrate
npm run dev
```

## How an agent connects to it

Point your MCP client's config at this process instead of the real upstream server directly,
e.g. in Devin CLI / Claude Desktop's MCP config:

```json
{
  "mcpServers": {
    "github-via-gateway": {
      "command": "node",
      "args": ["/path/to/mcp-trust-gateway/dist/index.js"],
      "env": {
        "GATEWAY_API_KEY": "mtg_...",
        "UPSTREAM_SERVER_NAME": "github",
        "DATABASE_URL": "postgres://...",
        "GATEWAY_ENCRYPTION_KEY": "..."
      }
    }
  }
}
```
