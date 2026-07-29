# MCP Trust Gateway

A transparent proxy that sits between any MCP client (Devin CLI, Claude Desktop, Cursor...)
and real MCP servers, adding what most agent tooling in this space is missing at once:
per-identity permissions across multiple servers, encrypted credential brokering, a
structured/redacted audit trail, *and* on-demand tool discovery so an agent's context cost
doesn't grow with every server you connect (measured 97.1% reduction — see below).

See [`DESIGN.md`](./DESIGN.md) for the full motivation (validated against 2026 research,
including a full competitive-landscape review), architecture, and phased plan — read that
first in any new session.

## Status

Phases 1 and 2 are complete and verified against real Postgres and real MCP servers — not
just intended behavior. 51 automated tests (34 unit + 17 integration), plus two specific,
falsifiable claims proven with real measurements:

- **Governance holds across multiple servers**: an identity can only discover/call tools on
  servers it has a grant for, verified against two real filesystem MCP servers with
  different permissions per identity — including the audit trail for a denied cross-server
  attempt (`scripts/manual_test_phase2.ts`).
- **Context cost stays flat**: `tools/list` through the gateway is a fixed 2 meta-tools
  regardless of how many real servers/tools sit behind it — measured with a real tokenizer
  at **97.1% fewer tokens** than a direct multi-server connection
  (`scripts/measure_context_overhead.ts`).

See `DESIGN.md`'s status log and Phase 2 section for the full detail.

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
    "trust-gateway": {
      "command": "node",
      "args": ["/path/to/mcp-trust-gateway/dist/index.js"],
      "env": {
        "GATEWAY_API_KEY": "mtg_...",
        "DATABASE_URL": "postgres://...",
        "GATEWAY_ENCRYPTION_KEY": "..."
      }
    }
  }
}
```

Note there's no `UPSTREAM_SERVER_NAME` (or similar) here — as of Phase 2, the gateway
connects to *every* server this API key's identity has any permission grant on, derived
from the `permissions` table, and exposes them all through the same two meta-tools
(`find_tool`, `call_tool`). One MCP client entry, many governed servers behind it.
