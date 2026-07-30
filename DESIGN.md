# MCP Trust Gateway — Design

## What this is and why

A proxy that sits between any MCP client (Devin CLI, Claude Desktop, Cursor...) and one
or more real upstream MCP servers, adding the trust/control plane most agent tooling in
this space is missing: per-role permissions, encrypted credential brokering, a
structured audit trail, and on-demand tool discovery so an agent's context cost doesn't
grow with every server connected (measured 97.1% reduction — see `scripts/`).

This is a genuinely competed category (Microsoft, IBM, and several funded/SOC 2 startups
already ship "MCP gateway with RBAC + audit"). The niche here specifically: fully open,
no platform lock-in, genuinely simple to self-host, with real RBAC + an encrypted
credential vault + audit built in from the start — most competitors either paywall that
combination or require adopting a large platform.

## Architecture — hexagonal (ports & adapters)

```
src/
  domain/       business logic + entities. Zero framework/infra imports — depends only
                on ports/. ToolCallHandler, ToolDiscoveryRouter, SelfServiceHandler,
                AdminToolHandler, connectAccessibleServers, types, constants, redact.
  ports/        interfaces adapters must implement — one per storage concern
                (*Repository), plus UpstreamToolClient, UpstreamConnectionProvider,
                CredentialVault, RateLimiter, RelayAgentRegistry, Queryable.
  adapters/     concrete implementations, grouped by real technology:
                postgres/ (one Postgres* class per port), mcp/ (subprocess spawning),
                security/ (AES-256-GCM, api keys, session tokens), http/ (rate limiter),
                relay/ (dispatches execution to a connected relay agent instead of
                spawning locally — see "Relay agent" below).
  entrypoints/  the two composition roots — the only code allowed to import both a port
                and its concrete adapter and wire them together:
                stdio/index.ts    one process, one identity, spawned locally by a client
                http/httpServer.ts  one persistent process serving many identities over
                                    the network, plus the /agent WebSocket endpoint
```

Dependency rule, checkable by grep: nothing in `domain/`/`ports/` imports from
`adapters/`/`entrypoints/`. `adapters/` may reference `domain/types.ts`/`constants.ts`
(shared vocabulary) but never a `domain/` behavior class. Only `entrypoints/` knows about
both a port and which adapter satisfies it for a given process.

```
Agent (Devin CLI, Claude Desktop, Cursor...)
   │ stdio: GATEWAY_API_KEY directly       HTTP: POST /login → session token,
   │                                       then Authorization: Bearer <token> on /mcp
   ▼
┌──────────────────────────────────────────────────────────────┐
│ 1. Resolve identity → user → union of every role they hold    │
│ 2. Connect to every server that role access covers            │
│    (local subprocess, or dispatched to a relay agent if the    │
│    server is only reachable from a specific network)           │
│ 3. Expose a small fixed set of meta-tools regardless of how    │
│    many real servers/tools sit behind it: find_tool, call_tool,│
│    list_services, register_my_credential, manage_roles (admin) │
│ 4. Per call: check permission → decrypt credential → forward → │
│    write an audited, redacted log entry                        │
└──────────────────────────────────────────────────────────────┘
   ▼
Real MCP servers
```

Requires no changes to the agent or to upstream MCP servers — point an existing
MCP-compatible client's config at the gateway instead of directly at the real server.

### Relay agent

Some servers (an internal SonarQube/Jenkins instance, say) are only reachable from a
specific network — a subprocess spawning without crashing only proves the binary starts,
not that the network call it will eventually make can succeed. For those, mark the
server `requires_relay = true`; `RoutingUpstreamConnectionProvider` then dispatches
execution to a connected relay agent instead of spawning locally — `RelayUpstreamConnectionProvider`
implements the *same* `UpstreamConnectionProvider` port `PerSessionUpstreamConnectionProvider`
does, so no domain code changed to support this.

The agent (`relay-agent/`, a genuinely separate package — see its own README) connects
*outbound* to the gateway's `/agent` WebSocket (nothing needs an inbound port open on its
network), authenticated like any other client (a real, revocable API key). It holds no
database credentials and no master encryption key — only its own API key, and, per active
call, whatever already-decrypted env the gateway sends it. Not "another MCP": MCP's own
client/server relationship is always client-initiated, but here the gateway needs to
initiate toward the agent, so `ports/RelayAgentRegistry.ts` defines its own small
request/response protocol instead of reusing MCP's shape.

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Language/runtime | TypeScript / Node.js | Speaks MCP as both server and client simultaneously; most real MCP servers run as npm packages, easy to spawn from the same runtime. |
| Storage | PostgreSQL | A real service from day one, not a single-file prototype. |
| Encryption | AES-256-GCM at the application layer | Portable if the database ever changes; keeps the key out of the DB process entirely. |
| Access model | Roles, not per-user grants | A user's effective access is the union of every role they hold — matches how real organizations actually assign access. |
| Credentials | Per-user, never a server-level default | No privileged "default" user whose personal token everyone else silently shares. |
| Transports | Both stdio and HTTP, same domain code | Matches how real production MCP servers (e.g. `mcp-atlassian`) are actually built — not specific to this project. |

## Current status

Verified against real Postgres, real MCP servers, and a real deployment (Neon + Render) —
not just intended behavior. 156 tests (101 unit, 51 integration, 4 e2e — see "Testing").

- **Governance across multiple servers**: an identity only discovers/calls tools on
  servers its roles grant, enforced identically whether reached via `find_tool` or
  `call_tool` directly.
- **Context cost stays flat**: `tools/list` exposes a small fixed meta-tool set
  regardless of how many real servers/tools sit behind it — 97.1% fewer tokens than a
  direct multi-server connection at N=2, measured with a real tokenizer.
- **Roles + self-service**: permissions are granted to roles; every user gets
  `list_services`/`register_my_credential` (see own credential status, register their
  own — never grants permission itself); an `admin` role additionally gets `manage_roles`,
  structurally absent from a non-admin's session, not just hidden.
- **Credential vault**: AES-256-GCM, per-(user, server), no shared default anywhere.
- **Audit trail**: every call, allowed or denied, with redacted params.
- **Two transports, same domain code**: stdio (one process per identity) and HTTP (one
  persistent process, session tokens, rate limiting) — see README.md.
- **Relay agent**: executes servers only reachable from a specific network, on a
  machine that actually has access to it, without the gateway's master key ever leaving
  the server that runs the gateway itself.
- **CI**: `.github/workflows/ci.yml` — an ephemeral Postgres service container, typecheck
  + all three test suites on every push/PR.

## Testing

```bash
npm test              # unit — fakes only, no real Postgres
npm run test:integration  # real Postgres, one rolled-back transaction per test
npm run test:e2e       # real built processes, real MCP protocol, no fakes at all
```

See `scripts/README.md` for operator tools and manual smoke tests, `migrations/README.md`
for the schema itself.

## Backlog

**Design/architecture**
- [ ] **`find_tool`/connection design, scoped 2026-07-29** — two related gaps found in
      the same conversation, with one fix for both:
      1. `find_tool` only does substring matching — no synonyms/semantic search.
      2. Every accessible server is connected (subprocess spawned) at session start,
         for every session, even if that session only ever ends up calling one of them
         — necessary today because `find_tool` needs to call `listTools()` on a live
         connection to know what a server offers before it can search across them.

      **Researched how real tool-heavy agent systems solve this** (LangChain's own
      "tool retrieval" pattern, the ToolReAGt paper (ACL 2025), and OSS projects
      ToolScope/ToolScout/tool-selector-cascade) — all converge on the same cascade:
      embeddings + cosine similarity as a cheap first filter (~20ms, local, ~$0),
      escalating to a reranker or a micro-LLM only past ~hundreds-to-thousands of
      tools. At this project's real scale (tens of tools per role), only the first
      stage is justified — a reranker/LLM stage would be pure overhead here.

      **Proposed design**: decouple *knowing what a server offers* from *being
      connected to it*.
      - A `tool_catalog` table: one row per (server, tool) — name, description, and an
        embedding vector, plus when it was last refreshed.
      - Populated lazily, as a side effect of a connection that would have happened
        anyway (a server needing a credential has no shared default to catalog it
        with up front — see "Remove the shared default upstream credential" — so the
        first user who successfully connects with their own credential builds it;
        the catalog itself — names/descriptions — isn't sensitive and doesn't need to
        be scoped to who built it). Credential-less servers can be cataloged
        immediately on registration.
      - Refreshed opportunistically: whenever `call_tool` connects to a server for
        real (which already happens), refresh its catalog entry if missing or older
        than a TTL (a week, say) — no new scheduler/cron process needed. A manual
        `refresh_catalog` admin action covers "I know it changed, don't wait."
      - `find_tool` embeds the query and searches the cache directly — zero
        connections. `call_tool` becomes the *only* thing that ever connects, lazily,
        to exactly the one server it needs — this is what actually fixes gap 2, as a
        consequence of fixing gap 1 correctly, not a separate change.
      - Embeddings: a small local model (`all-MiniLM-L6-v2` class, ~90MB) via
        `@xenova/transformers` (pure JS/WASM, no Python, no GPU needed) — not an
        external API (would add a mandatory network call + secret to a path that
        runs on every query, and break offline/stdio use) and not a full LLM (this is
        a textbook embedding-similarity task; an LLM would be slower and costlier for
        no quality gain at this scale).
      - Real tradeoff accepted: connections drop from "every accessible server, every
        session" to "once per server, refreshed occasionally" — not to zero. There's
        no way to know what a server offers without ever having connected to it.
      - Not yet decided: exact TTL, whether embeddings run inline in
        `entrypoints/http/httpServer.ts`/`entrypoints/stdio/index.ts` or a small
        dedicated module, and whether `pgvector` is worth adding for indexed search
        versus a plain in-memory linear scan (likely fine at this project's scale —
        tens to low hundreds of cached tools, not millions).
- [ ] TOCTOU window: a mid-flight permission revoke doesn't stop a call already in flight.
- [ ] No per-server error isolation for HTTP mode's relay path specifically — the local
      path already isolates failures (`connectAccessibleServers.ts`); relay dispatch
      failures should degrade the same way.
- [ ] No connection pooling — each session opens its own subprocess even if another
      identity is already connected to the same server.
- [ ] No master-key rotation path (only one server's stored credential at a time).
- [ ] Only one relay agent supported at a time; no admin visibility into which agents are
      connected or which servers currently have one.

**Production readiness**
- [ ] No automated tests for HTTP mode's own composition root wiring (only stdio mode's,
      via `test/e2e/`) — manual smoke test only (`scripts/manual_test_http.ts`).
- [ ] No high-availability story — HTTP mode is one process.
- [ ] Nothing supervises the process (no systemd/PM2/restart policy).
- [ ] No Postgres backup strategy documented.
- [ ] No metrics/alerting beyond the audit log itself.
- [ ] No dependency-update process.
- [ ] Two Neon `users` rows exist for the same real person (should be two `identities`
      under one `user` instead — the exact scenario that split was designed for).

**Distribution/packaging**
- [ ] No `LICENSE` file.
- [ ] Not packaged for easy install (no Docker image, no npm package).
- [ ] No `docker-compose.yml` to bring up Postgres + the gateway together.

## Infrastructure requirements

| Requirement | Current state |
|---|---|
| Postgres reachable over the network, migrated | Neon (managed) for real use; local Docker only for the test suite |
| A host running `entrypoints/http/httpServer.ts` persistently | Render |
| Valid TLS | Handled by Render; code also supports `HTTP_TLS_CERT_PATH`/`HTTP_TLS_KEY_PATH` directly |
| Secrets management | Plain environment variables (Render's own secret storage) — no Vault/Secrets Manager |
| Node.js ≥ 20 | Declared in `package.json`'s `engines` |
