# MCP Trust Gateway

A transparent proxy that sits between any MCP client (Devin CLI, Claude Desktop, Cursor...)
and real MCP servers, adding the trust/control plane most agent tooling is currently missing:
per-identity permissions, encrypted credential brokering, and a structured, redacted audit
log of every tool call.

See [`DESIGN.md`](./DESIGN.md) for the full motivation (validated against 2026 research on
gaps in agent tooling), architecture, and phased plan — read that first in any new session.

## Status

Phase 1 (MVP) is functionally complete and verified end to end against a real Postgres and
the official filesystem MCP server. See `DESIGN.md`'s status log for details and what's next.

## Setup

```bash
# 1. Postgres (Docker)
docker run -d --name mcp-trust-gateway-postgres \
  -e POSTGRES_USER=gateway \
  -e POSTGRES_PASSWORD=gateway_dev_password \
  -e POSTGRES_DB=mcp_trust_gateway \
  -p 5433:5432 \
  postgres:17-alpine

# 2. Config
npm install
cp .env.example .env   # fill in DATABASE_URL (matches the docker run above) and generate
                        # GATEWAY_ENCRYPTION_KEY with:
                        # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Schema
npm run migrate

# 4. Seed a test identity + the filesystem server (no credentials needed) for a first try
npx tsx scripts/seed_test_setup.ts   # prints a GATEWAY_API_KEY to use below

# 5. Build and smoke-test
npm run build
TEST_GATEWAY_API_KEY=<from step 4> npx tsx scripts/manual_test_client.ts
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
