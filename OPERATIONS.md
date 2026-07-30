# Operations — running this thing day to day

The README covers *what this is* and *initial setup*. This is the playbook for
everything that comes after: onboarding people, registering servers, granting access,
and the handful of things worth knowing before you're mid-incident. If a step below
contradicts the README, the README wins — this is meant to stay in sync with it, not
replace it.

## First deployment, start to finish

```bash
npm install
cp .env.example .env   # fill in a real, managed Postgres (Neon or similar) -- see README's warning
npm run migrate
```

Generate the one master secret this deployment will ever have:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put that in `GATEWAY_ENCRYPTION_KEY`. **This is a deployment-wide secret, not a
per-machine one** — copy the exact same value to every machine that will run this
gateway against this database. Generating a *new* one anywhere else means that machine
can never decrypt credentials saved elsewhere (see README's own warning — this has
actually happened).

```bash
npx tsx scripts/seed_default_roles.ts     # admin/developer/basic roles + jira/sonarqube/jenkins as a starting point
npx tsx scripts/provision_user.ts <you> admin   # or: provision without a role, then scripts/bootstrap_admin.ts <you>
npm run build
```

You now have an admin API key. Configure your MCP client with it (see README's "Two ways
to connect" for the exact `mcpServers` JSON for stdio vs. HTTP mode).

## Onboarding a new person

Two ways, pick based on how much you trust "give them a token, they do the rest" vs.
"I'll just do it":

### Self-service (HTTP mode only)

1. As an admin, over an HTTP session: `manage_roles({action: "create_invitation",
   roleName: "basic"})` — prints a one-time token (`mtgi_...`), shown once. `roleName`
   defaults to `"basic"` if omitted; `ttlHours` defaults to 7 days.
2. Send that token to the new person (Slack/email — never a public channel; whoever has
   it can redeem it once).
3. They redeem it themselves, with no prior account at all — either open
   `https://your-gateway-host/redeem-invitation?token=mtgi_...` in a browser (a plain
   HTML page, no login needed to view it), or:
   ```bash
   curl -X POST https://your-gateway-host/redeem-invitation \
     -H "Content-Type: application/json" \
     -d '{"token": "mtgi_...", "name": "their-chosen-name"}'
   ```
   Response: `{"apiKey": "mtg_...", "userName": "..."}`. That API key is theirs now —
   they configure their own MCP client with it (README's "Two ways to connect").

Redeeming twice, or after the TTL expires, fails with a clear error — ask for a new
token rather than reusing an old one.

**Why "basic" only grants jira by default**: it's the one server here safe to hand to a
total stranger with zero vetting, because it's registered against the real
`mcp-atlassian` binary with each user bringing their *own* Jira API token afterward (see
`scripts/register_my_credential` below) — nothing works until they do. Don't add a
server to `basic` that doesn't check a real per-user credential the same way (see
`scripts/seed_default_roles.ts`'s own docstring for the incident that taught this).

### Admin-provisioned (either mode)

```bash
DATABASE_URL=... GATEWAY_ENCRYPTION_KEY=... npx tsx scripts/provision_user.ts <name> [roleName]
```

Prints their API key once — send it to them directly, don't store it yourself. Omit
`roleName` to assign one later with `manage_roles`' `assign_role`.

## Registering a new MCP server

Same `{command, args}` shape any MCP client config already uses. Two ways:

**From inside an admin session** (no shell access needed):
```
manage_roles({action: "register_server", name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"]})
manage_roles({action: "grant_permission", roleName: "developer", serverName: "github"})
```

**From the CLI**, in one step:
```bash
npx tsx scripts/register_server.ts github npx developer -- -y @modelcontextprotocol/server-github
```

A newly registered server has no credential of its own (see README/DESIGN.md — there is
deliberately no shared default). Each user who needs one registers their own:
```
register_my_credential({server: "github", env: {"GITHUB_TOKEN": "their own token"}})
```

**Before granting a role blanket access to a server, check whether it's actually
reachable from wherever the gateway process runs.** A server on an internal-only network
(an intranet SonarQube/Jenkins, say) will register and spawn without error even from a
publicly-hosted deployment — it just can never complete a real call. If that's your
situation, register it with `requiresRelay: true` and run a `relay-agent/` on a machine
that actually has network access (see `relay-agent/README.md`).

## Managing roles and permissions

Roles are what permissions actually attach to — a user's effective access is the union
of every role they hold (`migrations/007_roles.sql`).

```
manage_roles({action: "create_role", name: "qa", isAdmin: false})
manage_roles({action: "grant_permission", roleName: "qa", serverName: "jira", toolName: "jira_search"})   # one tool
manage_roles({action: "grant_permission", roleName: "qa", serverName: "jira"})                             # every tool (blanket)
manage_roles({action: "revoke_permission", roleName: "qa", serverName: "jira"})
manage_roles({action: "assign_role", userName: "alice", roleName: "qa"})
manage_roles({action: "unassign_role", userName: "alice", roleName: "qa"})
manage_roles({action: "list_roles"})
manage_roles({action: "list_users"})   # every user with their current roles
```

## Credential and catalog housekeeping

```
manage_roles({action: "delete_credential", userName: "alice", serverName: "jira"})   # theirs, not everyone's
manage_roles({action: "refresh_catalog", serverName: "jira"})   # force re-list a server's tools now, don't wait for the weekly TTL
```

`scripts/set_user_credential.ts` sets a credential *on someone's behalf* — most users
should use `register_my_credential` themselves instead; this is for an operator doing it
for them.

## Checking what happened

```
manage_roles({action: "list_users"})
```
or, for the actual audit trail (every call, allowed or denied, redacted params):
```bash
npx tsx scripts/view_audit_log.ts --help
```

## See also

- `README.md` — what this is, setup, meta-tools reference.
- `DESIGN.md` — architecture, decisions, and the full backlog (including real incidents
  this project's own history found and fixed).
- `scripts/README.md` — every script here, in more detail, plus manual smoke tests.
- `migrations/README.md` — the schema itself.
- `.devin/agent-instructions-template.md` (or wherever you keep it in your own
  project) — a template for telling an agent to use this gateway instead of connecting to
  real MCP servers directly, so no one accidentally works around the governance this
  project exists to provide.
