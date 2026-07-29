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
# 1. Postgres (Docker) — two databases: one for the running gateway, one dedicated to
#    integration tests (never point both env vars at the same database — see
#    test/integration/setupDatabase.ts for why).
docker run -d --name mcp-trust-gateway-postgres \
  -e POSTGRES_USER=gateway \
  -e POSTGRES_PASSWORD=gateway_dev_password \
  -e POSTGRES_DB=mcp_trust_gateway \
  -p 5433:5432 \
  postgres:17-alpine
docker exec mcp-trust-gateway-postgres psql -U gateway -d postgres -c "CREATE DATABASE mcp_trust_gateway_test;"

# 2. Config
npm install
cp .env.example .env   # fill in DATABASE_URL and TEST_DATABASE_URL (matching the docker run
                        # above) and generate GATEWAY_ENCRYPTION_KEY with:
                        # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Schema — apply to BOTH databases
npm run migrate                                            # DATABASE_URL
DATABASE_URL=$TEST_DATABASE_URL npx tsx scripts/migrate.ts  # TEST_DATABASE_URL

# 4. Seed a test identity + the filesystem server (no credentials needed) for a first try
npx tsx scripts/seed_test_setup.ts   # prints a GATEWAY_API_KEY to use below

# 5. Build and smoke-test
npm run build
TEST_GATEWAY_API_KEY=<from step 4> npx tsx scripts/manual_test_client.ts
```

## Tests

```bash
npm run typecheck        # tsc --noEmit, includes src/ and test/
npm test                 # unit tests (node:test, no extra framework) — no database needed
npm run test:integration # Postgres repositories against a real, migrated TEST_DATABASE_URL
npm run test:all         # all three, in order
```

See `DESIGN.md`'s "Testing" section for what each layer covers, and what's intentionally
still left to the manual smoke test.

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
