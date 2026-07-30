# MCP Trust Gateway

A proxy between any MCP client (Devin CLI, Claude Desktop, Cursor...) and real MCP
servers, adding per-role permissions, encrypted credential brokering, an audit trail, and
on-demand tool discovery (97.1% fewer tokens than connecting to every server directly).

See [`DESIGN.md`](./DESIGN.md) for architecture and motivation.

## Setup

```bash
npm install
cp .env.example .env
# DATABASE_URL / GATEWAY_ENCRYPTION_KEY -> a real, managed Postgres (Neon or similar).
# Never point these at a local-only database you don't back up.
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" generates a key

npm run migrate
npx tsx scripts/seed_test_setup.ts   # prints a GATEWAY_API_KEY for a first try
npm run build
TEST_GATEWAY_API_KEY=<from above> npx tsx scripts/manual_test_client.ts
```

For local development only (never for the real deployment — see the warning above),
`docker compose up -d` brings up a Postgres matching `.env.example`'s defaults exactly,
with both databases integration tests need already created.

**`GATEWAY_ENCRYPTION_KEY` is a deployment-wide secret, not a per-machine or per-user
one.** Generate it exactly once per deployment (one shared `DATABASE_URL`), then copy the
*same* value to every machine that runs the gateway against that database — in stdio
mode, that means every one of your own machines. Every stored credential is encrypted
with whichever key was active when it was saved; generating a *new* key on a second
machine (rather than copying the existing one) means that machine can never decrypt
credentials saved from the first, even though both belong to the same user. HTTP mode
sidesteps this entirely — only the one centrally-hosted process ever holds this key, and
every device just talks to it as a client, see "Two ways to connect" below.

See [`OPERATIONS.md`](./OPERATIONS.md) for the full day-to-day playbook (onboarding
people, registering servers, granting access), `scripts/README.md` for every operator
tool in more detail, and `migrations/README.md` for the schema itself.

## Two ways to connect — same governance either way

| | stdio | HTTP |
|---|---|---|
| Who it's for | Solo use | A team, centrally managed |
| How it runs | Your MCP client spawns it locally | One persistent process everyone connects to |
| Auth | `GATEWAY_API_KEY` env var | `POST /login` with your API key → short-lived session token → `Authorization: Bearer <token>` on `/mcp` |
| Who needs Postgres access | Every machine running it | Only that one process |

```json
{
  "mcpServers": {
    "trust-gateway": {
      "command": "node",
      "args": ["/path/to/mcp-trust-gateway/dist/entrypoints/stdio/index.js"],
      "env": { "GATEWAY_API_KEY": "mtg_...", "DATABASE_URL": "postgres://...", "GATEWAY_ENCRYPTION_KEY": "..." }
    }
  }
}
```

For HTTP mode, most clients (Devin CLI included) support a remote server directly — no
local process needed:

```json
{
  "mcpServers": {
    "trust-gateway": {
      "url": "https://your-gateway-host/mcp",
      "transport": "http",
      "headers": { "Authorization": "Bearer <session-token>" }
    }
  }
}
```

If your client only supports stdio, see `bridge/` — holds only your API key locally,
never the database URL or master key. `npm run start:http` runs the server itself; see
`src/entrypoints/http/httpConfig.ts` for every HTTP-specific env var (port, TLS, rate
limits, session TTL) and their defaults.

**Getting your first API key without an admin running a script for you** (HTTP mode
only): if an admin gives you a one-time invitation token (`manage_roles`' `create_invitation`
action), redeem it yourself — no prior account needed. Either open
`https://your-gateway-host/redeem-invitation?token=mtgi_...` in a browser (a plain,
dependency-free page — enter your name, click Redeem), or:
```bash
curl -X POST https://your-gateway-host/redeem-invitation \
  -H "Content-Type: application/json" \
  -d '{"token": "mtgi_...", "name": "your-chosen-name"}'
# -> {"apiKey": "mtg_...", "userName": "..."}
```
One-time use, expires per the admin's own setting. See `OPERATIONS.md` for the admin side.

**One real limit**: a server only reachable from inside a specific network (an internal
SonarQube/Jenkins, say) can never be served by a gateway running on public cloud
infrastructure — no code fixes a network that doesn't route there. For those, see
`relay-agent/` — runs on a machine that actually has access, taking orders from the
gateway instead of deciding anything itself.

## Meta-tools

Every client sees a small, fixed set of tools regardless of how many real servers/tools
sit behind the gateway:

| Tool | Who sees it | Does |
|---|---|---|
| `find_tool` | Everyone | Semantically search real tools across servers you're permitted on (local embeddings, no data leaves the machine) |
| `call_tool` | Everyone | Call a real tool discovered via `find_tool` |
| `list_services` | Everyone | See every registered server and your status: `ready`, `needs_credential`, `not_permitted` |
| `register_my_credential` | Everyone | Set your own credential for a server you're already permitted on — never grants permission itself |
| `manage_roles` | Admins only | Create/delete roles, assign/unassign, grant/revoke permissions, register new servers, manage users/credentials, force a tool catalog refresh, issue self-service invitation tokens — structurally absent from a non-admin's session, not just hidden |

Permissions are granted to **roles** (`migrations/007_roles.sql`), not individual
users — your effective access is the union of every role you hold.

## Testing

```bash
npm test                  # unit — fakes only, no database
npm run test:integration  # real Postgres, one rolled-back transaction per test
npm run test:e2e          # real built processes, real MCP protocol
npm run test:all          # typecheck + test + test:integration
```

`.github/workflows/ci.yml` runs all of the above on every push/PR against a Postgres
service container that exists only for that job — never the same database as local dev
or the real deployment.

## License

[Apache 2.0](./LICENSE).
