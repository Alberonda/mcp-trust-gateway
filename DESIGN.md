# MCP Trust Gateway — Design & Plan

> This is the persistent memory doc for this project. Read this first in any new session
> before touching code — it has the validated motivation, the architecture decisions and
> why they were made, and the phased plan with current status.

## Origin story (why this project exists)

Started from a conversation exploring "build a personal AI-OS layer over the desktop"
(2026-07-28/29). Conclusion after research: that specific idea (desktop chat app + custom
skills protocol + own LLMs) is heavily saturated — see "Prior art already explored" below.
Instead of competing on the chat UI or reinventing MCP, we identified a genuinely validated,
under-served gap and pivoted the idea toward it.

### Validated gap (with sources, checked 2026-07-29)

Independent 2026 sources converge on the same diagnosis: agent **frameworks** (LangGraph,
CrewAI, Claude Agent SDK, MCP itself) solve orchestration and tool-calling, but almost
nothing solves the **trust/control plane** around them:

- Tacavar (2026): *"Layer 3 (infrastructure operations) is nearly empty... zero AI incident
  response tools, zero credential brokering products, zero commercial agent-to-agent trust
  protocols."*
- Koenig AI Academy (2026): current frameworks give orchestration + tool binding + memory,
  but not rollback checkpoints, lifecycle hooks with real block authority, or human-readable
  audit logs.
- ChatForest / DEV.to (2026): MCP itself has real, measured problems — Perplexity dropped
  MCP internally (March 2026) over context-window bloat (one documented case: 3 MCP servers
  consumed 72% of a 200k-token context window on tool schemas alone) and auth immaturity
  ("every team solving this independently" — no standard for token rotation, session expiry,
  or per-user scoping).

We also personally hit a milder version of this exact problem all session long while building
RAGWire (a separate, unrelated project): silent duplicate ingestion until we added explicit
skip/replace/insert reporting, an agent that "succeeded" with an empty response until we added
detection for it, a hallucinated filter value that reached Qdrant undetected until we added
sanitization. All ad-hoc, all after the fact. That's the lived version of "there's no generic
trust/observability layer for agent tool calls" — this project generalizes that fix.

### Prior art already explored (so we don't rebuild it)

- **Desktop chat UIs**: Open WebUI, LibreChat, AnythingLLM, Jan.ai — mature, open source,
  bring-your-own-backend. Not worth rebuilding.
- **Skills/tool protocol**: MCP (Anthropic, Nov 2024) — now under the Linux Foundation
  (Agentic AI Foundation), backed by OpenAI/Google/Microsoft/AWS, ~97M monthly SDK downloads
  (March 2026), ~10,000 public servers. Don't reinvent this — build ON it.
- **Personal "AI-OS" / second-brain markdown kits**: nateherkai/AIS-OS (public, MIT, ~1k
  GitHub stars) and an internal corporate adaptation (`internal-ghe.example.com/homeoftech/
  mbts-aios`) already exist and are unrelated to this project's direction.
- **MCP discovery/curation**: CuratedMCP already working on "which of the 10,000 servers are
  actually good" — not our problem to solve.

## Competitive landscape & differentiation (added 2026-07-29, later same day)

After Phase 1 shipped, a direct question ("if this doesn't exist, is it because nobody
needed it?") led to actually checking — properly, this time — whether "MCP gateway with
auth/permissions/audit" already exists as a product category. It does, extensively:

**Direct competitors found**: Permit.io's Permit MCP Gateway (commercial, RBAC/ABAC/ReBAC,
SOC 2), Microsoft's official `mcp-gateway` (Kubernetes-native, Entra ID), Portkey MCP
Gateway (org→team→user→server→tool permission hierarchy, IdP integration, commercial),
MCPX/Lunar.dev (SOC 2, immutable audit, vault-backed secrets), reaatech/mcp-gateway (open
source, OAuth/OIDC, tamper-evident audit chain, Redis-backed), IBM ContextForge (MIT,
40+ plugins, 100+ contributors), Docker MCP Gateway, Bifrost (Go, 11µs overhead, 5k RPS),
MCPJungle, Mcpgate-de/mcpgate (GDPR/PII focus). This is a mature, well-resourced, actively
competed category as of mid-2026, not an unclaimed gap — several of these shipped within
the same few months this project's core idea was conceived.

**Conclusion on positioning**: this project is not going to out-build Microsoft, IBM, or a
SOC 2-certified funded startup on "generic enterprise MCP governance." Continuing to treat
it as an unclaimed market opportunity would be dishonest. It remains valuable as (a) a real
engineering exercise (SOLID architecture, real tests, real Postgres — all still true and
still worth having built), and (b) a narrower, still-real niche identified from the
competitors' own documented weaknesses, not from guessing:

| Competitor | Its own documented weakness |
|---|---|
| MCPX | Intent-based access control and the org-wide catalog are Enterprise-tier only (paid) |
| Docker MCP Gateway | *"Access control and audit trails are largely build-it-yourself"* |
| Microsoft/Azure APIM | Governance depth requires buying into Azure APIM — not usable standalone |
| MCPJungle | *"No built-in RBAC or compliance tooling"* — explicitly aimed at small/dev setups without one |

Pattern: real RBAC + audit is either paywalled (MCPX, Portkey) or requires adopting a large
platform (Azure, IBM). The self-hosted, no-lock-in options (Docker, MCPJungle) explicitly
punt on governance. **Nobody in this list combines "genuinely simple to self-host, fully
open, no platform lock-in" with "real RBAC + encrypted credential vault + audit built in
from the start."** That combination is this project's niche now — narrow, not a business,
but real and defensible as an open-source project.

**A second, largely separate axis found during the same research, worth combining**: the
single most-cited *practical* pain point driving people away from naive MCP usage right now
isn't identity — it's context-window cost. One documented case (MikkoParkkola/mcp-gateway):
connecting 20 MCP servers with 100+ tools costs ~15,000 tokens of tool-schema overhead
before a conversation even starts — the same root cause behind Perplexity dropping MCP
internally (see "Validated gap" above). Almost none of the identity-focused gateways above
address this; only Bifrost touches it in passing ("Code Mode token reduction"). Combining
our RBAC/audit niche with on-demand tool discovery (expose a handful of small "meta-tools" —
e.g. `find_tool`, `call_tool` — instead of forwarding every real tool's full schema
upfront) is a genuinely less-crowded combination than pure identity/governance alone.

**Consequence for the plan**: on-demand tool discovery (which also requires lifting Phase
1's "one upstream server per gateway process" constraint — discovery across a single server
isn't very interesting) is reordered ahead of the original Phase 2 items (session tokens,
credential rotation). It's the actual differentiator; session-token maturity is closer to
hygiene/parity with what competitors already have. See the renumbered phased plan below.

## What this project actually is (current shape, post Phase 3 — see README.md for the two
## concrete ways to run it)

**An MCP proxy that sits between any MCP client (Devin CLI, Claude Desktop, Cursor...) and
one or more real upstream MCP servers**, adding the trust/control plane those don't have,
while exposing only two fixed meta-tools to the agent regardless of how many real servers
are behind it:

```
Agent (Devin CLI, Claude Desktop, Cursor...)
        │  MCP — stdio mode: GATEWAY_API_KEY directly (single process, single identity)
        │        HTTP mode: POST /login with an API key, then Authorization: Bearer
        │        <session token> on every /mcp request (see README.md)
        ▼
┌────────────────────────────────────────────────────────────────┐
│                       MCP TRUST GATEWAY                        │
│  1. Resolve identity → its user (permissions are per-user,     │
│     shared by every identity/API key that user holds)          │
│  2. Connect to every upstream server this user has any grant   │
│     on (PermissionRepository.findAccessibleServerIds)          │
│  3. Expose exactly two meta-tools to the agent: find_tool       │
│     (search real tools across accessible servers, permission-   │
│     filtered) and call_tool (route to the right server)         │
│  4. Per call: check permission → decrypt the real server's      │
│     credential → forward → write an audited, redacted log       │
│     entry (failures in that last step never mask a real result) │
└────────────────────────────────────────────────────────────────┘
        │
        ▼
Real MCP servers (GitHub, a customer's own backend, Qdrant, ...)
```

Key property: it requires **no changes to the agent or to upstream MCP servers** — point an
existing MCP-compatible client's config at the gateway instead of directly at the real
server, and it works. This is what makes it viable to build incrementally and test against
real tools from day one.

## Decisions made (2026-07-29)

| Decision | Choice | Why |
|---|---|---|
| Language/runtime | **TypeScript / Node.js** | The gateway must speak MCP as both a server (facing the agent) and a client (facing real servers) simultaneously — the official TS SDK is the reference implementation for this proxy pattern, and most real-world MCP servers run as npm packages (easy to spawn as subprocesses from the same runtime). |
| Initial scope | **Multi-identity from day 1, but not full login/session UI yet** | User explicitly wants multi-user + auth/encryption combined into this project, not deferred. Compromise to avoid over-building before anything works: v1 identities are static, hashed API keys per user/agent with a Postgres ACL. Real login/session tokens landed later, in Phase 3b (HTTP mode's `/login`) — this row is intentionally left as the original plan, for history; see Phase 3b for what was actually built. |
| Audit/credential storage | **PostgreSQL** (not SQLite) | Chosen explicitly by user — treat as a real service from day 1, not a personal single-file prototype. |
| Encryption | AES-256 at the application layer for the credential vault (real upstream API keys), TLS everywhere in transit | Standard, well-understood approach; avoids relying on Postgres-specific extensions (pgcrypto) so the encryption logic is portable if the DB changes later. |

## Architecture (current file layout — kept up to date as of Phase 3; if this ever
## drifts from `src/`'s actual contents again, trust `src/` and fix this section, not the
## other way around)

The first working version had all the right behavior but the wrong shape for a project
meant to grow: a single `main()` did config loading, DB queries, credential decryption,
subprocess spawning, *and* the permission/audit business logic inline inside the MCP
request handlers. That made the actual policy (the reason this project exists) untestable
without a real Postgres and a real spawned subprocess. Refactored into, and grown since:

```
src/
  constants.ts           — every named value that would otherwise be a magic number/string
  config.ts               — reads process.env for what BOTH entry points need
                            (DATABASE_URL, GATEWAY_ENCRYPTION_KEY) + stdio-only GATEWAY_API_KEY
  security/
    vault.ts               — AES-256-GCM for the upstream credential vault
    apiKeys.ts              — long-lived API key generation/hashing
    sessionTokens.ts        — short-lived session token generation/hashing (Phase 3b) —
                              same approach as apiKeys.ts, different prefix (mtgs_ vs mtg_)
  db/
    types.ts                — plain domain types (User, Identity, UpstreamServer, ...)
    pool.ts                  — pg.Pool factory; nothing else creates its own connection
    Queryable.ts             — the one method repositories need, satisfied by pg.Pool AND a
                              transactional pg.PoolClient (what makes integration tests work)
    UserRepository.ts | IdentityRepository.ts | PermissionRepository.ts | SessionRepository.ts
    | UpstreamServerRepository.ts | AuditLogRepository.ts
                              — one repository per concern, each behind an interface
    SafeAuditLogRepository.ts — decorates any AuditLogRepository so a write() failure can
                              never mask a tool call that actually succeeded (Phase 2.5)
  gateway/
    UpstreamToolClient.ts    — the minimal slice of the MCP SDK's Client a handler needs
    UpstreamConnectionProvider.ts — spawns/connects to one real server; shared by both
                              entry points so the connect-and-decrypt logic exists once
    summarizeResult.ts       — pure function, own unit tests
    ToolCallHandler.ts       — THE core policy for one server (permission check → forward
                              or deny → audit), constructor-injected interfaces only
    ToolDiscoveryRouter.ts   — composes one ToolCallHandler per accessible server; exposes
                              exactly find_tool/call_tool regardless of how many real
                              servers/tools sit behind it (Phase 2's differentiator)
  httpGateway/               — everything specific to HTTP mode (Phase 2.5/3b); stdio mode
                              never imports from here
    httpConfig.ts            — HTTP-only env vars (port, TLS, rate limits, session TTL)
    auth.ts                  — Authorization header → Identity, for both an API key
                              (POST /login only) and a session token (everything else)
    RateLimiter.ts            — in-memory per-identity token bucket
    HttpStatusError.ts        — lets session-creation logic carry a real HTTP status code
    httpServer.ts             — composition root for HTTP mode (see index.ts for stdio's)
  redact.ts                 — unchanged, was already single-purpose
  index.ts                  — composition root for STDIO mode: one process, one identity
                              resolved once at boot, spawned locally by an MCP client
```

Every repository is an interface + a `Postgres*` implementation — swapping storage later,
or using a fake in a test, means writing a new implementation of the same interface, not
touching `ToolCallHandler`/`ToolDiscoveryRouter`. Two composition roots (`index.ts` for
stdio, `httpGateway/httpServer.ts` for HTTP) share everything except how they resolve an
identity and how many of them a running process serves at once — see README.md's "Two
deployment modes" for when to use which.

## Testing

`npm test` runs `node:test` (Node's built-in runner, via `tsx` — no new test-framework
dependency) against every `src/**/*.test.ts`. Test files sit next to the code they cover,
excluded from the production build (`tsconfig.json`'s `exclude`).

- `security/apiKeys.test.ts`, `security/vault.test.ts`, `redact.test.ts`,
  `gateway/summarizeResult.test.ts` — pure-function/pure-class unit tests, no fakes needed.
- `gateway/ToolCallHandler.test.ts` — the most valuable suite: in-memory fakes for
  `PermissionRepository`, `AuditLogRepository`, and `UpstreamToolClient` prove the actual
  policy (allow/deny/error paths, redaction, audit status, that a denied call never reaches
  upstream) without a database or a subprocess. This is the direct payoff of the
  dependency-inversion refactor above.
- `httpGateway/*.test.ts` — `RateLimiter.test.ts` (pure logic, injectable clock) and
  `auth.test.ts` (both header-resolution functions, with fakes for `IdentityRepository`/
  `SessionRepository` — no HTTP server involved).
- `test/integration/*.test.ts` (`npm run test:integration`) — all six `Postgres*Repository`
  classes (`User`, `Identity`, `Permission`, `Session`, `UpstreamServer`, `AuditLog`)
  against a real, migrated Postgres. Each test runs inside a transaction that's always
  rolled back (`test/integration/setupDatabase.ts`'s `withTransaction`), so tests can
  freely INSERT fixtures without leaving data behind or needing manual cleanup — shared
  seeding helpers live in `test/integration/testFixtures.ts`. This required loosening the
  repositories' constructors from `pg.Pool` to a minimal `Queryable` interface
  (`db/Queryable.ts`) — satisfied structurally by both `pg.Pool` and a transactional
  `pg.PoolClient`, so tests can hand in a client mid-transaction with zero changes to the
  repository code.
  - **Runs against `TEST_DATABASE_URL`, a separate database from `DATABASE_URL`** — running
    these against the same database used for manual smoke-testing
    (`scripts/seed_test_setup.ts`) caused real unique-constraint collisions the first time
    this was tried. Needs its own migrated database; see README.md.
  - **Caught a real bug**, not a hypothetical one: `AuditLogRepository.findRecentByIdentity`
    ordered by `created_at DESC` alone. Postgres's `now()` is fixed for the whole duration
    of a transaction, so several rows written inside one transaction (exactly what a test
    inserting three audit entries does) all get the identical `created_at`, and the order
    between ties is unspecified. Fixed by adding `id DESC` as a tiebreaker. The unit test
    suite's in-memory fake couldn't have caught this — it doesn't model transactional
    timestamp semantics — which is the whole point of also having integration tests.
- Neither composition root (`index.ts` nor `httpGateway/httpServer.ts`) has automated
  tests of its own wiring — both are covered by manual smoke tests instead
  (`scripts/manual_test_client.ts`, `scripts/manual_test_phase2.ts`,
  `scripts/manual_test_http.ts`). They're mostly composition (build real objects, connect
  a transport), lower-value to unit-test than the logic they wire together — this is a
  known, accepted gap, not an oversight (see Phase 2.5's "Not yet done" note).
- 90 tests total as of Phase 3 (58 unit + 32 integration) — see the Status log below for
  how that grew phase by phase; treat any specific number quoted earlier in this document
  as a historical snapshot, not the current count.

## Phased plan

### Phase 1 (MVP) — functionally complete, verified 2026-07-29
- [x] Postgres schema: `identities` (hashed API key), `permissions` (ACL: identity →
      allowed (server, tool) pairs), `upstream_servers` (encrypted upstream secrets),
      `audit_log` (who/what/when/result, secrets redacted).
- [x] MCP proxy core: accepts MCP connections from an agent, authenticates via API key,
      forwards `tools/list` and `tools/call` to one real upstream MCP server. Verified
      against `@modelcontextprotocol/server-filesystem`.
- [x] Permission check before every forwarded call; reject + log if the identity isn't
      allowed to call that (server, tool). Verified: revoking a permission row correctly
      denies a previously-working call.
- [x] Every call (allowed or rejected) writes a structured audit log row, with credential/
      secret values redacted before storage.
- [x] Real automated test suite — see "Testing" above. 22 unit tests (`npm test`) covering
      crypto, redaction, and the full ToolCallHandler policy with fakes, plus 13 integration
      tests (`npm run test:integration`) covering every Postgres repository against a real
      database. `index.ts` itself is still only covered by the manual smoke test.

### Phase 2 — complete and verified 2026-07-29 (the actual differentiator, see
### "Competitive landscape & differentiation" above)

Two falsifiable claims were defined before writing any code (see the verification plan
from that session) — both were proven with real measurements, not intended behavior:

**Claim A — governance holds across multiple servers.** *"An identity can only discover
and call tools it has permission for, even when the gateway is connected to N ≥ 2 upstream
servers."*
- [x] `PermissionRepository.findAccessibleServerIds()` + `UpstreamServerRepository
      .findManyByIds()` — the composition root connects to every server an identity has
      any grant on, derived from the permissions table, no longer a single env var.
- [x] `ToolDiscoveryRouter` composes one `ToolCallHandler` per accessible server (Open/
      Closed — `ToolCallHandler` itself untouched) and exposes exactly two meta-tools,
      `find_tool`/`call_tool`, regardless of how many real servers/tools sit behind it.
      `find_tool` re-checks `ToolCallHandler.isToolAllowed()` per candidate, so discovery
      is exactly as strict as calling — never a way to enumerate tools you can't call.
- [x] 7 new unit tests (`ToolDiscoveryRouter.test.ts`) directly demonstrating Claim A with
      fakes: cross-server leakage, tool-level (not just server-level) filtering, denied
      calls never reaching a handler, and an unregistered-server call still writing an
      audit entry (a real gap found manually — see below).
- [x] **Verified against two real filesystem MCP servers** (`scripts/seed_phase2_demo.ts`
      + `scripts/manual_test_phase2.ts`): `narrow-agent` (permission on `sandbox-a` only)
      never sees or can call anything on `sandbox-b`; `broad-agent` (both) sees and calls
      both. Confirmed in the real `audit_log` table, not just process output.
  - **Gap found and fixed during manual verification**: a call to a server the identity
    was never even connected to (zero grants) returned a clean "Unknown server" error but
    wrote *no* audit entry — the rejection happened in `ToolDiscoveryRouter` before
    reaching any `ToolCallHandler`. Fixed by giving the router its own narrow
    identity+audit-log dependency for exactly this one case, so "complete audit trail of
    every decision" is actually true, not true-with-an-asterisk.

**Claim B — context-window cost stays flat.** *"The token size of `tools/list` stays
~constant regardless of how many real tools/servers are registered."*
- [x] `scripts/measure_context_overhead.ts` — real `gpt-tokenizer` (o200k_base encoding)
      token counts, not estimates, comparing a direct multi-server MCP connection against
      the same servers through the gateway.
  - **Measured, 2 real filesystem servers**: direct connection = 5,594 tokens; through the
    gateway = 163 tokens (the two meta-tools' own schemas) — **97.1% reduction**, measured.
  - Extrapolated (clearly labeled as such, not measured) from the per-server average to
    N=5/10/20 servers: reduction climbs toward ~99-100% as more servers are added, since
    the gateway's cost is constant while direct-connection cost grows linearly per server.

Total automated coverage after Phase 2: **51 tests** (34 unit + 17 integration), all green.

### Post-Phase-2 self-audit (2026-07-29 — SOLID/scalability review before starting Phase 3)

Requested explicitly before continuing: re-check the Phase 2 code itself against the same
bar as the earlier refactor (SOLID, no magic values, scalability), not just "does it work."
Five real issues found and fixed, not cosmetic ones:

1. **Magic strings**: `"find_tool"`/`"call_tool"` were repeated as bare literals in
   `META_TOOLS` and in `handleMetaToolCall`'s dispatch — renaming one wouldn't have updated
   the other. Extracted a single `MetaTool` const object both now reference.
2. **DIP violation**: `index.ts`'s `connectServer()` helper was typed against
   `PostgresPermissionRepository`/`PostgresAuditLogRepository` (concrete classes) instead of
   the `PermissionRepository`/`AuditLogRepository` interfaces `ToolCallHandler` itself
   correctly depends on. Fixed for consistency.
3. **Inconsistent/dishonest data**: `ToolDiscoveryRouter`'s audit entry for an
   unknown-server call hardcoded `durationMs: 0` instead of using an injectable clock like
   `ToolCallHandler` does. Added the same `now: () => number` pattern.
4. **Real scalability bug**: `findTool()` called `ToolCallHandler.isToolAllowed()` once per
   *candidate tool* — with N servers and M tools each, that's O(N × M) Postgres round trips
   for a single search. Replaced with `PermissionRepository.findAllowedToolNames()`
   (`AllowedTools = "all" | ReadonlySet<string>`), one query per server, checked in memory
   against every candidate — O(N) round trips instead. `ToolCallHandler.isToolAllowed()`
   was removed (dead after this change) in favor of `ToolCallHandler.getAllowedToolNames()`.
5. **Real scalability bug**: `findTool()` awaited each server's handler sequentially in a
   `for` loop — total latency was the *sum* of every connected server's response time.
   Rewritten with `Promise.all` across handlers (and across each handler's own
   `listTools()`/`getAllowedToolNames()` pair), so total latency is bounded by the slowest
   single server, not the sum of all of them.

Re-verified after the fixes: 54 tests (34 unit + 20 integration, +3 new integration tests
for `findAllowedToolNames`), the real two-server manual demo, and the token measurement
script all still produce identical, correct results (97.1% reduction unchanged) — the
fixes changed the implementation's shape, not its observable behavior.

### Architectural gaps found 2026-07-29 — both now resolved (kept here for the history of
### how they were found, not as a "still open" list)

Two real gaps surfaced by direct questioning, not found proactively:

1. **Fixed, same day.** Audit-log write failures could misreport a successful call as
   failed. `ToolCallHandler.callTool()`'s success path called `upstreamClient.callTool()`
   then `auditLog.write()` inside the same `try` — if the upstream call succeeded but the
   *audit write* then threw (e.g. a transient Postgres blip), the `catch` block treated
   it as a call failure and rethrew to the agent, which could retry an action that already
   happened (real risk for anything non-idempotent). Fixed with `SafeAuditLogRepository`
   (`src/db/SafeAuditLogRepository.ts`): a decorator around any `AuditLogRepository` whose
   `write()` never throws — failures are reported via an injectable callback (defaults to
   `console.error`) instead. `findRecentByIdentity` (reads) is deliberately NOT wrapped —
   a failed read has no successful action to mask. Wired in once, at the composition root
   (`index.ts`), with **zero changes** to `ToolCallHandler`/`ToolDiscoveryRouter` — exactly
   the payoff of depending on the `AuditLogRepository` interface rather than a concrete
   class. Verified the fix actually matters: temporarily removing the wrapper reproduces
   the original bug exactly (`Error: Postgres is unreachable` propagating out of a call
   that had already succeeded upstream) — confirmed with a throwaway test file before
   reverting; the permanent regression test lives in `ToolCallHandler.test.ts`.
   There's still a smaller, unfixed TOCTOU window between the permission check and the
   actual call (a mid-flight revoke doesn't stop an already-in-flight call) — lower
   severity since permission changes are expected to be infrequent.

2. **Resolved by Phase 2.5, below.** The deployment model had an unresolved
   centralization question: the gateway *process* genuinely needs no infrastructure to
   deploy — each user's MCP client (Devin/Claude/Copilot) spawns it locally as a stdio
   subprocess by pointing at `dist/index.js`. But for governance to mean anything across
   a *team* (not just solo use), `DATABASE_URL` has to point at one shared Postgres
   reachable from every machine running the gateway — otherwise each person's
   permissions/audit trail is a private silo. That, in turn, would mean every developer's
   laptop needing direct Postgres credentials, a materially larger attack surface than
   the commercial competitors' architecture (Permit.io, Portkey), who run one
   centrally-hosted gateway *service* that alone touches the database. Resolved by
   option (b) below — HTTP mode — rather than option (a) (restricting a shared Postgres
   role): only `httpGateway/httpServer.ts`'s one running process needs direct database
   access now; team members' machines only need network access to wherever that runs.

### Phase 2.5 — centralized HTTP deployment mode — done, 2026-07-29

Resolves open gap #2 above via option (b): a second deployment mode where the gateway runs
as one persistent, centrally-hosted service that every team member's MCP client connects to
over the network (`StreamableHTTPServerTransport`, already in the installed SDK), instead of
each person spawning their own local stdio process with direct Postgres credentials. The
stdio mode (`src/index.ts`) isn't being removed — it's still the simplest option for solo
use — this is an additional entry point for team use.

**Decisions**:
- **Upstream connections**: one real MCP server subprocess per incoming session initially
  (mirrors the existing, already-tested stdio-mode wiring), *not* a shared pool across
  identities yet — introducing both a new transport and a new connection-sharing model in
  the same change is more risk than necessary. Sits behind a new
  `UpstreamConnectionProvider` interface specifically so swapping in a pooled
  implementation later doesn't require touching call sites again.
- **Identity resolution moves from once-at-boot to once-per-connection**: stdio mode reads
  one `GATEWAY_API_KEY` env var and resolves one identity for the whole process lifetime;
  HTTP mode must read a `Authorization: Bearer <key>` header on each incoming session and
  resolve identity dynamically, since one server process now serves many different
  identities concurrently.
- **Scope for this iteration**: explicitly asked for production-oriented, not a bare
  proof-of-concept — includes robust HTTP error handling (a single bad request must never
  crash the whole process), basic per-identity rate limiting (viable now that this is a
  long-lived process with in-memory state, unlike the one-shot stdio mode), and optional
  built-in TLS (cert/key via env vars) for cases where there's no reverse proxy in front.

**Shipped and verified 2026-07-29**:
- `src/gateway/UpstreamConnectionProvider.ts`: the credential-decrypt-and-spawn logic
  factored out of `index.ts` into `PerSessionUpstreamConnectionProvider`, reused by both
  entry points. `index.ts` (stdio mode) now uses this too — refactor, not new behavior;
  re-verified the stdio manual demo still passes identically after the change.
- `src/httpGateway/`: `httpConfig.ts` (port/host/TLS/rate-limit env vars, extends the base
  `DATABASE_URL`/`GATEWAY_ENCRYPTION_KEY` config shared with stdio mode), `auth.ts`
  (`Authorization: Bearer <key>` → identity, resolved fresh per request — never throws,
  every failure mode returns a caller-safe error string), `RateLimiter.ts` (in-memory token
  bucket per identity, injectable clock, 5 unit tests), `HttpStatusError.ts`, and
  `httpServer.ts` (the composition root: Express via the SDK's own
  `createMcpExpressApp` — which includes DNS-rebinding protection — session map keyed by
  MCP's own session ID, `StreamableHTTPServerTransport` per session, TLS via
  `HTTP_TLS_CERT_PATH`/`HTTP_TLS_KEY_PATH` or plain HTTP behind a reverse proxy, graceful
  shutdown closing every active session and its upstream subprocesses on SIGTERM/SIGINT).
- **Verified for real, not just "compiles"**: started the built server, connected two
  *different* identities to the *same running process* concurrently
  (`scripts/manual_test_http.ts` + an ad hoc multi-tenancy script) — `narrow-agent` saw
  only `sandbox-a`, `broad-agent` saw both, exactly as in the stdio-mode demo, but now both
  over the network against one shared process. Confirmed in the real `audit_log` table.
  Also verified: an unauthenticated request is rejected with 401 before touching any MCP
  protocol machinery, and TLS mode actually serves HTTPS (self-signed cert, real `curl -k`
  request over TLS) rather than just type-checking.
- 69 tests total (49 unit + 20 integration) after this phase, all green.
- Not yet done: automated (not just manual) tests for `httpServer.ts` itself, and the
  pooled-upstream-connections optimization explicitly deferred in the decisions above.

### Phase 3 (was Phase 2 — parity/hygiene, still worth doing, just not the differentiator)

**3a — per-user permissions: done, 2026-07-29.** Permissions now attach to a `user`, not an
individual identity (API key/session) — one user can hold several identities that all
automatically share the same grants, instead of every new key needing its own permission
rows configured separately.
- `migrations/002_users.sql`: new `users` table; `identities.user_id` (NOT NULL, backfilled
  1:1 for pre-existing identities so nothing already granted was dropped);
  `permissions.identity_id` → `permissions.user_id` (column rename via
  add-backfill-drop, unique constraint updated to match).
- Real gap found and fixed as a side effect: `scripts/migrate.ts` had no
  migration-tracking table (fine with exactly one migration; broke the moment there were
  two — "relation already exists"). Fixed with a standard `schema_migrations` table,
  each migration applied in its own transaction.
- `db/types.ts`: `Identity` gained `userId`; new `User` type. `db/UserRepository.ts`
  (new). `db/PermissionRepository.ts`: every method's `identityId` parameter is now
  `userId` — a genuine semantic change, not a rename for its own sake.
- `ToolCallHandler` checks permissions via `identity.userId`, but still *audits* via
  `identity.id` — deliberately kept separate: knowing which specific credential made a
  call is more forensically useful than only knowing which user it belonged to.
- **Verified against real Postgres, not just migrated schema**: provisioned a brand-new
  API key for the existing `broad-agent` user with zero permission rows of its own, and
  confirmed over a real stdio connection that it immediately saw the same servers
  (`sandbox-a` + `sandbox-b`) as `broad-agent`'s original key — proving shared grants
  actually work end to end, not just at the schema level. New integration test covers the
  same case (`PermissionRepository.test.ts`: "two identities belonging to the same user
  share that user's grants").
- 70 tests total (49 unit + 21 integration) after this sub-phase, all green.

**3b — session tokens: done, 2026-07-29.** HTTP mode's `/mcp` no longer accepts a raw API
key directly — it authenticates via a short-lived session token instead, obtained by
first exchanging the long-lived API key at `POST /login`. Reduces how often the
long-lived credential itself is transmitted over the wire, without changing anything
about stdio mode (a single-shot local process gets no real benefit from a login
round-trip, so it keeps using its API key directly, as before).
- `migrations/003_sessions.sql`: new `sessions` table — stores **both** `user_id`
  (permission checks) and `identity_id` (audit attribution), so logging in doesn't lose
  the "which specific credential did this" granularity Phase 3a deliberately preserved.
- `security/sessionTokens.ts`: mirrors `apiKeys.ts`'s approach exactly (same threat
  model — a server-generated high-entropy secret, not a user-chosen password, so a fast
  SHA-256 hash is appropriate) but with its own prefix (`mtgs_` vs `mtg_`) so the two are
  visually distinguishable, e.g. in logs.
- `db/SessionRepository.ts` (new): `create`/`findByToken` (expiry checked in the query
  itself, never a separate step a caller could forget)/`revoke`.
- `db/IdentityRepository.ts` gained `findById` — sessions store an `identityId`, not a
  full `Identity`, so this is how a resolved session turns back into the `Identity` object
  `ToolCallHandler`/`ToolDiscoveryRouter` already know how to use, unchanged.
- `httpGateway/auth.ts`: new `resolveIdentityFromSessionToken`, symmetric with the
  existing `resolveIdentityFromAuthHeader` (now used only by `/login`) — same
  never-throws, caller-safe-error contract.
- `httpServer.ts`: `POST /login` (API key → session token) and `POST /logout` (revokes
  it); all three `/mcp` routes switched from API-key to session-token resolution.
- **Verified against a real, running server, not just unit tests**: the full round trip
  — login with a real API key, connect to `/mcp` with the returned session token, call a
  real tool, then confirm the *raw API key no longer works directly against `/mcp`*
  (401 — must log in first), and that logging out immediately invalidates the session
  token (401 on reuse). `scripts/manual_test_http.ts` covers all of this.
- 84 tests total (58 unit + 26 integration) after this sub-phase, all green.

**3c — credential rotation: done, 2026-07-29.** `UpstreamServerRepository.updateCredential()`
re-encrypts a server's stored secret in place — same id/name/command, so every existing
permission grant referencing that server keeps working unchanged; only the credential
itself changes. Throws for a nonexistent server id instead of silently doing nothing.
`scripts/rotate_upstream_credential.ts` is the operator-facing entry point (server name +
new plaintext credential as CLI args). Only affects connections made *after* rotation —
already-connected sessions/processes keep whatever credential they started with until they
reconnect, which was judged not worth engineering further given both entry points'
connections are already short-lived (see DESIGN.md's Phase 2.5 notes on
`PerSessionUpstreamConnectionProvider`).
- **Verified against real Postgres with a real encrypted round trip**: registered a test
  server with an encrypted credential, ran the rotation script against it, then decrypted
  the stored value with `CredentialVault` directly and confirmed it matched the *new*
  plaintext, not the old one — not just that the database row changed shape.
- 3 new integration tests (rotate-and-verify, id-preserved-across-rotation,
  throws-for-unknown-server-id).

**3d — audit log viewer: done, 2026-07-29.** `AuditLogRepository.search()` — filter by any
combination of identity name, server, status, and a result limit, or none at all (returns
the most recent entries across every identity). `scripts/view_audit_log.ts` is the CLI:
`npx tsx scripts/view_audit_log.ts --server=github --status=denied --limit=10`. Kept as a
CLI, not a web view, matching the phase plan's "at minimum" bar — a web UI wasn't judged
worth the added surface area yet.
- **Verified against real accumulated data**: ran the CLI against the dev database's real
  audit trail (built up over every manual test in this session) with and without filters —
  output correctly showed identity names, server/tool pairs, status, duration, and a
  one-line result summary, filtered exactly as requested.
- 4 new integration tests for `search()` (no filters, identity-name filter, combined
  server+status filter, limit).

Total after Phase 3 (3a-3d): **90 tests** (58 unit + 32 integration), all green.

### Phase 4 (advanced, may not be worth doing — revisit after Phases 1-3 prove useful)
- [ ] Rollback/checkpoint hooks for known-destructive operation types (file writes, DB
      writes) — flagged in research as the hardest, most tool-specific problem; no
      general solution exists yet anywhere.

### Backlog (not scheduled to a phase yet)
- [ ] **Improve `find_tool`'s matching beyond plain substring search.** Today
      `ToolDiscoveryRouter.findTool()` does a case-insensitive `.includes()` on the tool's
      name/description — no synonyms, no semantic understanding (a query of "borrar" would
      not match a tool named "delete_file"). Works reasonably today because agents tend to
      search using terms close to MCP's English naming conventions, but it's not robust.
      If it becomes a real problem: embeddings + similarity search (the same approach
      RAGWire already uses) is the natural upgrade path, at the cost of adding an
      embeddings-provider dependency to what's otherwise a deliberately lightweight gateway
      — worth weighing carefully before adding, not a default yes.

## Status log

> This log stops narrating in detail after Phase 2 — Phase 2.5 and Phase 3 (3a-3d) each
> have their own full write-up (motivation, decisions, what was verified and how) directly
> under their `###` headings above; this log just anchors them in chronological order
> rather than repeating them. Read the phase sections for detail, this log for sequence.

- **2026-07-29 (latest)**: Phase 3 complete (3a per-user permissions, 3b session tokens,
  3c credential rotation, 3d audit log CLI viewer — see each sub-heading above). Also
  fixed a real gap found as a side effect of adding a second migration file:
  `scripts/migrate.ts` had no migration-tracking table. 90 tests total (58 unit + 32
  integration). Also did a documentation pass on this file and README.md after being
  asked directly whether they'd gone stale — they had (an out-of-date architecture
  diagram and file tree, a contradiction between the "open gaps" section and Phase 2.5
  which actually closed one of them, and an actively wrong README table claiming HTTP
  mode still accepted a raw API key per request after Phase 3b changed that). Fixed all
  of it rather than just noting it.
- **2026-07-29 (later)**: Phase 2.5 (centralized HTTP deployment mode) shipped and
  verified against a real running server with two concurrent identities — see its
  section above for full detail.
- **2026-07-29 (later still)**: Phase 2 shipped and verified — see the Phase 2 section
  above for the full detail. Summary: defined two falsifiable claims before writing code,
  proved both with real measurements (not fakes-only, not "should work"): governance holds
  across multiple real servers (audited, including a gap found and fixed during manual
  verification), and `tools/list` token cost dropped 97.1% (measured with a real tokenizer
  against 2 real MCP servers) versus a direct multi-server connection. 51 tests total.
- **2026-07-29 (end of day)**: Ran a proper competitive-landscape check after a direct
  challenge ("if this doesn't exist, is it because nobody needed it?"). Found ~10 existing
  MCP gateways with auth/RBAC/audit, including Microsoft and IBM official projects and
  multiple SOC 2-certified commercial products. Reframed positioning honestly (see
  "Competitive landscape & differentiation" above) and reprioritized the plan: on-demand
  tool discovery (a less-crowded axis found in the same research) is now Phase 2, ahead of
  the original Phase 2 (session tokens/rotation), which moved to Phase 3. No code changed
  in this update — planning only.
- **2026-07-29**: Project scaffolded. Idea validated via research (see sources above).
  Stack and Phase 1 scope decided. Repo created at
  `/Users/AREYESM/PycharmProjects/mcp-trust-gateway`. Code not yet written beyond scaffold.
- **2026-07-29 (later same session)**: Phase 1 proven end to end against a real Postgres
  (Docker container `mcp-trust-gateway-postgres`, host port 5433) and a real MCP server
  (`@modelcontextprotocol/server-filesystem`, no credentials needed — good first target).
  Verified with `scripts/manual_test_client.ts` (a throwaway smoke test, not a real test
  suite yet):
  - Allowed call: `read_text_file` on a granted identity returns the real file content
    through the proxy, and writes an `allowed_success` audit_log row.
  - Denied call: revoking the permission row makes the same call return a clean
    "Permission denied" MCP error result instead of reaching the upstream server at all,
    and writes a `denied` audit_log row.
  - `scripts/seed_test_setup.ts` added as the (temporary, Phase-1-only) way to provision
    a test identity/server/permission — real provisioning is Phase 2's job.
  Next session should start with: either a real test suite (currently zero automated
  tests), or moving on to Phase 1's remaining item (permission list is done; the last
  Phase 1 checkbox — structured/redacted audit log — is also done) — so Phase 1 is
  functionally complete pending decision on what test coverage is worth adding before
  starting Phase 2.
