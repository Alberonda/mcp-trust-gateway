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

Phases 1, 2, 2.5, and 3 are complete and verified against real Postgres and real MCP
servers — not just intended behavior. 90 automated tests (58 unit + 32 integration), plus:

- **Governance holds across multiple servers**: an identity can only discover/call tools on
  servers it has a grant for, verified against two real filesystem MCP servers with
  different permissions per identity — including the audit trail for a denied cross-server
  attempt (`scripts/manual_test_phase2.ts`).
- **Context cost stays flat**: `tools/list` through the gateway is a fixed 2 meta-tools
  regardless of how many real servers/tools sit behind it — measured with a real tokenizer
  at **97.1% fewer tokens** than a direct multi-server connection
  (`scripts/measure_context_overhead.ts`).
- **Permissions are per-user, not per-key**: a brand-new API key for an existing user
  immediately shares that user's grants, verified end to end (not just at the schema
  level) by provisioning one and connecting with it.
- **HTTP mode's `/mcp` requires a session token, not the raw API key**: verified the full
  login → connect → call → logout round trip against a real running server, including
  confirming the raw API key stops working directly against `/mcp` once you've logged in
  (`scripts/manual_test_http.ts`).
- **Operator tooling**: `scripts/set_user_credential.ts` (set/rotate one user's own
  credential for a server — see "Operator tools" below) and `scripts/view_audit_log.ts`
  (a filterable CLI over the audit trail), both exercised against real data, not just
  their own tests.

See `DESIGN.md`'s status log and phase sections for the full detail.

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

# 3. Schema — apply to BOTH databases. Safe to re-run any time (e.g. after pulling a new
#    migration file) — scripts/migrate.ts tracks what's already applied and only runs what's new.
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

## Two deployment modes

| | Stdio mode (`src/index.ts`) | HTTP mode (`src/httpGateway/httpServer.ts`) |
|---|---|---|
| Who it's for | Solo use | A team — centrally-managed permissions/audit |
| How it runs | Spawned locally by each person's MCP client | One persistent, centrally-hosted process everyone connects to over the network |
| Identity | One `GATEWAY_API_KEY`, resolved once at boot | `POST /login` with your API key first, then a short-lived **session token** on every `/mcp` request — see below |
| Who needs Postgres credentials | Every machine running the gateway | Only this one process |
| Permissions | Per user — every API key/session that user holds shares the same grants | Same (permissions are per-user regardless of deployment mode) |

Use stdio mode to try things out. Use HTTP mode for real team use — see DESIGN.md's
"Architectural gaps found 2026-07-29" for why stdio mode alone doesn't scale to a team
without giving every laptop direct database access.

### Running HTTP mode

```bash
npm run build
DATABASE_URL=... GATEWAY_ENCRYPTION_KEY=... HTTP_PORT=3443 npm run start:http
```

Environment variables (all optional except the two shared with stdio mode):

| Variable | Default | Purpose |
|---|---|---|
| `HTTP_PORT` | `3443` | Port to listen on |
| `HTTP_HOST` | `127.0.0.1` | Bind address — binding to `0.0.0.0`/`::` without `HTTP_ALLOWED_HOSTS` logs a DNS-rebinding warning |
| `HTTP_ALLOWED_HOSTS` | — | Comma-separated hostnames for DNS-rebinding protection when not bound to localhost |
| `HTTP_TLS_CERT_PATH` / `HTTP_TLS_KEY_PATH` | — | Set both to serve HTTPS directly; otherwise runs plain HTTP (fine behind a reverse proxy that terminates TLS, not otherwise) |
| `HTTP_RATE_LIMIT_MAX_TOKENS` | `60` | Token-bucket capacity per identity |
| `HTTP_RATE_LIMIT_REFILL_PER_SECOND` | `1` | Token-bucket refill rate per identity |
| `HTTP_SESSION_TTL_MINUTES` | `60` | How long a session token issued via `POST /login` stays valid |

### Authenticating in HTTP mode: log in first, then connect

`/mcp` does **not** accept your long-lived API key directly — exchange it for a
short-lived session token first:

```bash
curl -X POST https://host:port/login -H "Authorization: Bearer mtg_..."
# {"token": "mtgs_...", "expiresAt": "2026-07-29T15:00:00.000Z"}
```

Then point your MCP client at `/mcp` with that session token instead:
`Authorization: Bearer mtgs_...`. When you're done, `POST /logout` with the session token
invalidates it immediately. Session tokens default to a 1-hour lifetime
(`HTTP_SESSION_TTL_MINUTES`) — see `scripts/manual_test_http.ts` for a full worked
example, including confirming the raw API key is rejected if used directly against `/mcp`.

## How an agent connects in stdio mode

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

## Connecting without a local process

For HTTP mode, most MCP clients (Devin CLI included) support remote servers directly —
point them at the deployed `/mcp` URL instead of spawning anything locally:

```json
{
  "mcpServers": {
    "trust-gateway": {
      "url": "https://mcp-trust-gateway.onrender.com/mcp",
      "transport": "http",
      "headers": { "Authorization": "Bearer <session-token-or-api-key>" }
    }
  }
}
```

If your client only supports local stdio servers, or you'd rather not send a long-lived
`GATEWAY_API_KEY` on every request, see `bridge/` — a thin relay that holds only your API
key locally (never `DATABASE_URL`/`GATEWAY_ENCRYPTION_KEY`) and keeps a short-lived session
token fresh on your behalf.

**A real limitation found while trying this**: any upstream server that's only reachable
from inside a private/corporate network (e.g. an on-prem SonarQube instance) can never be
served by a gateway running on public cloud infrastructure like Render — no amount of code
changes fixes a network that simply doesn't route there. For those specific servers, run
the gateway itself somewhere with network access to them (locally, or on infrastructure
inside that network) — this isn't optional depending on how the gateway is deployed.

### A real worked example (secrets redacted)

Before adopting the gateway, a typical MCP client config lists every real server directly
— each one reachable straight from the agent, ungoverned, with its own raw credentials
sitting in the config file:

```json
{
  "mcpServers": {
    "jira": {
      "command": "/bin/bash",
      "args": ["/path/to/mcp-wrappers/jira-atlassian.sh"]
    },
    "github-mcp-server": {
      "command": "/path/to/mcp-wrappers/github-enterprise.sh",
      "args": []
    },
    "sonarqube": {
      "command": "docker",
      "args": ["run", "--init", "-i", "--rm", "-e", "SONARQUBE_TOKEN", "-e", "SONARQUBE_URL", "mcp/sonarqube-mb"],
      "env": {
        "SONARQUBE_TOKEN": "squ_...",
        "SONARQUBE_URL": "https://sonarqube.example.com"
      }
    }
  }
}
```

**What it actually looks like today**, after migrating `jira` and `sonarqube` to be
*registered servers behind the gateway* (see DESIGN.md's "Real integrations migrated
behind the gateway" for the full story, including a real security fix that landed first
because of this migration, and a Docker-vs-corporate-CA problem SonarQube specifically hit):

```json
{
  "mcpServers": {
    "github-mcp-server": { "command": "/path/to/mcp-wrappers/github-enterprise.sh", "args": [] },
    "trust-gateway": {
      "command": "node",
      "args": ["/path/to/mcp-trust-gateway/dist/index.js"],
      "env": { "GATEWAY_API_KEY": "mtg_...", "DATABASE_URL": "postgres://...", "GATEWAY_ENCRYPTION_KEY": "..." }
    }
  }
}
```

`jira` and `sonarqube` don't appear here at all anymore — each became one
`upstream_servers` row (via `scripts/lib/registerServer.ts`) instead of a standalone
config entry, and every call to either now goes through the gateway's permission check
and audit log. `github-mcp-server` is intentionally still standalone — no blocking issue
found migrating it, just not done yet; it's the natural next candidate.

Two things worth knowing if you do this yourself:
- **Jira needed no `env` at all** — its wrapper script pulls credentials from macOS
  Keychain at runtime, independent of who spawned it, so only `{command, args}` had to be
  registered.
- **SonarQube's original Docker-based image couldn't be migrated as-is**: a Docker
  container doesn't inherit the host machine's trust store, so it failed TLS validation
  against an internal corporate SonarQube instance whose certificate is signed by a
  private corporate CA. Switched to a Docker-free npm-based MCP server for SonarQube
  instead (`sonarqube-server-mcp`) — runs as a plain Node process, so it inherits the same
  trust store native wrappers like Jira's already do.

## Operator tools

None of these talk to a running gateway process — all connect to Postgres directly, so
they work regardless of which deployment mode you're using.

```bash
# Set (or rotate) ONE user's own credential for an already-registered server. There is no
# server-level default to fall back to (see DESIGN.md's "Remove the shared default
# upstream credential") -- every user, including whoever registered the server, needs
# their own row here for anything that needs credentials at all. Pass the FULL env map
# the server needs, not just the one value that changed.
DATABASE_URL=... GATEWAY_ENCRYPTION_KEY=... \
  npx tsx scripts/set_user_credential.ts <user-name> <server-name> '{"KEY":"this-users-own-value"}'

# Query the audit trail — every filter is optional
DATABASE_URL=... npx tsx scripts/view_audit_log.ts \
  [--identity=<name>] [--server=<name>] [--status=allowed_success|allowed_failure|denied] [--limit=<n>]
```

Registering a new server (`scripts/lib/registerServer.ts`) uses the same `{command, args}`
shape as any MCP client config, minus `env` — a server never carries its own credential
(see "Remove the shared default upstream credential"); use `set_user_credential.ts`
above once it's registered, for each user who needs one.
