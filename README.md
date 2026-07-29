# MCP Trust Gateway

A transparent proxy that sits between any MCP client (Devin CLI, Claude Desktop, Cursor...)
and real MCP servers, adding what most agent tooling in this space is missing at once:
per-identity permissions across multiple servers, encrypted credential brokering, a
structured/redacted audit trail, *and* on-demand tool discovery so an agent's context cost
doesn't grow with every server you connect (measured 97.1% reduction — see below).

See [`DESIGN.md`](./DESIGN.md) for the full motivation (validated against 2026 research,
including a full competitive-landscape review), architecture, and phased plan — read that
first in any new session.

## Who can consume this, and how

Any MCP client can talk to this gateway either way below — nothing about the tools/
permissions/audit logic differs between them, only how a client reaches it:

- **stdio** (`src/entrypoints/stdio/index.ts`): the client (Devin CLI, Claude Desktop, ...) spawns
  `node dist/entrypoints/stdio/index.js` itself as a local subprocess and talks to it over stdin/stdout.
  No network involved in reaching the gateway itself.
- **HTTP** (`src/entrypoints/http/httpServer.ts`, `streamable-http` transport): any client —
  including a custom chatbot/agent that only knows how to call HTTP endpoints — can
  connect to a persistent, centrally-hosted instance (see the Render deployment) over the
  network, the same way you'd point a client at any other remote MCP server.

This mirrors how real, widely-used MCP servers are actually built — not something
specific to this project. `sooperset/mcp-atlassian` (the real Jira/Confluence MCP; see
`jira` in this repo's own examples) supports stdio *and* SSE/streamable-http from the
same tool implementations, with a `UserTokenMiddleware` resolving per-request auth in
HTTP mode — the same shape as this project's `httpGateway/auth.ts` and session tokens.
Nothing about the MCP protocol requires a server to run locally; that's a deployment
choice each MCP server's maintainers make, same as this one.

## Status

Phases 1 through 3.5, plus role-based access control and self-service credentials, are
complete and verified against real Postgres and real MCP servers — not just intended
behavior. 129 automated tests (78 unit + 51 integration), plus:

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
- **Access is role-based, and users can self-configure**: permissions are granted to
  roles (e.g. "developer", "hr"), not individual users — a user's access is the union of
  every role they hold. Beyond `find_tool`/`call_tool`, every user always has
  `list_services` (see what's permitted vs. what still needs a credential) and
  `register_my_credential` (set their own credential for something they're already
  permitted on — never grants that permission itself). An `admin` role additionally gets
  `manage_roles`, hidden entirely from non-admins. Verified end to end with two real
  roles and two real users against the real gateway process, not just at the schema
  level — see DESIGN.md's "Role-based access control + self-service credentials".

See `DESIGN.md`'s status log and phase sections for the full detail.

## Setup

**There is exactly one real database, for every real user, regardless of which mode
they connect through** — a managed Postgres (this project uses Neon). Local Docker
Postgres is *only* ever used as disposable scratch space for running the test suite (see
"Tests" below and `.github/workflows/ci.yml`) — never for real permissions, credentials,
roles, or audit history. Pointing a real `DATABASE_URL` at a laptop-only database that
nobody backs up is how you end up unable to answer "where did my users' data go" the day
that laptop dies; don't do it, not even "just for now."

```bash
# 1. Config — DATABASE_URL/GATEWAY_ENCRYPTION_KEY point at your real, managed Postgres
#    (Neon or similar). TEST_DATABASE_URL is a completely separate, disposable database
#    (a local Docker container is fine for this one specifically — see "Tests").
npm install
cp .env.example .env
# generate GATEWAY_ENCRYPTION_KEY with:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Schema — safe to re-run any time (e.g. after pulling a new migration file) —
#    scripts/migrate.ts tracks what's already applied and only runs what's new.
npm run migrate

# 3. Seed a test identity + the filesystem server (no credentials needed) for a first try
npx tsx scripts/seed_test_setup.ts   # prints a GATEWAY_API_KEY to use below

# 4. Build and smoke-test
npm run build
TEST_GATEWAY_API_KEY=<from step 3> npx tsx scripts/manual_test_client.ts
```

For running the test suite locally (not against your real database — see "Tests"),
stand up a disposable Postgres just for that:

```bash
docker run -d --name mcp-gateway-test-db \
  -e POSTGRES_USER=gateway -e POSTGRES_PASSWORD=gateway_test_password \
  -e POSTGRES_DB=mcp_trust_gateway_test -p 5433:5432 postgres:17-alpine
# TEST_DATABASE_URL=postgres://gateway:gateway_test_password@localhost:5433/mcp_trust_gateway_test
DATABASE_URL=$TEST_DATABASE_URL npx tsx scripts/migrate.ts
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

| | Stdio mode (`src/entrypoints/stdio/index.ts`) | HTTP mode (`src/entrypoints/http/httpServer.ts`) |
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
      "args": ["/path/to/mcp-trust-gateway/dist/entrypoints/stdio/index.js"],
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
      "args": ["/path/to/mcp-trust-gateway/dist/entrypoints/stdio/index.js"],
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
# the server needs, not just the one value that changed. Most users should do this
# themselves via the register_my_credential meta-tool instead -- this script is for an
# operator setting it on someone else's behalf.
DATABASE_URL=... GATEWAY_ENCRYPTION_KEY=... \
  npx tsx scripts/set_user_credential.ts <user-name> <server-name> '{"KEY":"this-users-own-value"}'

# Bootstrap the very first admin (creates the admin role if it doesn't exist yet, and
# grants it to a named, already-provisioned user). Deliberately a manual, one-off step --
# never run automatically by a migration. Every admin after the first can be made one via
# the manage_roles meta-tool instead.
DATABASE_URL=... npx tsx scripts/bootstrap_admin.ts <user-name>

# Query the audit trail — every filter is optional
DATABASE_URL=... npx tsx scripts/view_audit_log.ts \
  [--identity=<name>] [--server=<name>] [--status=allowed_success|allowed_failure|denied] [--limit=<n>]
```

Registering a new server (`scripts/lib/registerServer.ts`) uses the same `{command, args}`
shape as any MCP client config, minus `env` — a server never carries its own credential
(see "Remove the shared default upstream credential"); use `set_user_credential.ts`
above (or, better, have the user run `register_my_credential` themselves) once it's
registered.

## Relay agent — for servers only reachable from a specific network

Some real upstream servers (an internal SonarQube/Jenkins instance, say) can only ever be
reached from inside a specific network — a subprocess spawning without crashing only
proves the binary starts, not that the network call it will eventually make can succeed.
For those, mark the server `requires_relay = true` and run `relay-agent/` (a genuinely
separate package, own dependencies, own build) on a machine that actually has network
access to it:

```bash
cd relay-agent
npm install && npm run build
GATEWAY_API_KEY=mtg_... GATEWAY_URL=https://your-gateway-host node dist/index.js
```

It connects *outbound* to the gateway's `/agent` endpoint (nothing needs an inbound port
open on this machine) and, from then on, executes exactly what the gateway tells it to —
holding no database credentials and no master encryption key, only its own
`GATEWAY_API_KEY` and, for each active call, whatever already-decrypted env the gateway
sends it. Every other server keeps being spawned directly by whichever process is
running the gateway, same as always; this only changes *where the subprocess physically
runs* for the servers that specifically need it.

## Roles and self-service

Permissions are granted to **roles**, not individual users — see `migrations/007_roles.sql`.
A user's effective access is the union of every role they hold. Beyond `find_tool`/
`call_tool`, every connected user always has two more meta-tools:

- **`list_services`**: every registered server and this user's status for it —
  `ready`, `needs_credential`, or `not_permitted`.
- **`register_my_credential({server, env})`**: set your own credential for a server
  you're already permitted on. Never grants that permission itself.

A user whose role has `is_admin = true` additionally gets `manage_roles({action, ...})`
— `create_role`, `delete_role`, `assign_role`, `unassign_role`, `list_roles`,
`list_users`, `delete_user`, `delete_credential`. Completely hidden from `tools/list` for
anyone else — not just undocumented, structurally absent from what a non-admin's session
can even see or call.

```bash
# Sets up sensible defaults: an empty "admin" role (grant it to someone with
# bootstrap_admin.ts above) and a "developer" role with access to jira/sonarqube/jenkins.
# Idempotent -- safe to re-run.
DATABASE_URL=... npx tsx scripts/seed_default_roles.ts
```

## Testing

```bash
npm test              # unit tests (fakes only, no real Postgres)
npm run test:integration  # real Postgres, one rolled-back transaction per test
npm run test:e2e       # see below
npm run test:all       # typecheck + test + test:integration
```

`test:e2e` is a different kind of test from everything else here: it builds the real
gateway, spawns it as a real subprocess, drives it over the real MCP protocol, and
verifies the result with raw SQL against Postgres — completely bypassing the
repositories under test, since the whole point is proving a credential submitted through
a real session actually lands correctly encrypted in the real table, not just that a
class agrees with itself. Requires `TEST_DATABASE_URL` and `GATEWAY_ENCRYPTION_KEY`; see
`test/e2e/roleBasedCredentials.e2e.test.ts`.

## CI

`.github/workflows/ci.yml` runs `typecheck` + all three test suites on every push/PR,
against a Postgres service container that exists only for that one job run — not the
same database as local development (see "Setup" above) or the real Neon-hosted
deployment; CI needs zero persistent state, so every run starts from an identical, empty
database and throws it away afterward.
