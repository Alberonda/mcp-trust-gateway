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

## What this project actually is

**An MCP proxy that sits between any MCP client (Devin CLI, Claude Desktop, Cursor...) and
real upstream MCP servers**, adding the trust/control plane those don't have:

```
Agent (Devin CLI, Claude Desktop, Cursor...)
        │  MCP, authenticated with a gateway-issued API key
        ▼
┌───────────────────────────────────────┐
│           MCP TRUST GATEWAY            │
│  1. Verify API key → resolve identity  │
│  2. Check permission (Postgres ACL)    │
│  3. Decrypt the real upstream credential│
│  4. Forward the call to the real server │
│  5. Write a structured, redacted audit  │
│     log entry (Postgres)                │
└───────────────────────────────────────┘
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
| Initial scope | **Multi-identity from day 1, but not full login/session UI yet** | User explicitly wants multi-user + auth/encryption combined into this project, not deferred. Compromise to avoid over-building before anything works: v1 identities are static, hashed API keys per user/agent with a Postgres ACL — real login/session tokens land in Phase 2 (already planned regardless). |
| Audit/credential storage | **PostgreSQL** (not SQLite) | Chosen explicitly by user — treat as a real service from day 1, not a personal single-file prototype. |
| Encryption | AES-256 at the application layer for the credential vault (real upstream API keys), TLS everywhere in transit | Standard, well-understood approach; avoids relying on Postgres-specific extensions (pgcrypto) so the encryption logic is portable if the DB changes later. |

## Architecture (post-refactor, 2026-07-29)

The first working version had all the right behavior but the wrong shape for a project
meant to grow: a single `main()` did config loading, DB queries, credential decryption,
subprocess spawning, *and* the permission/audit business logic inline inside the MCP
request handlers. That made the actual policy (the reason this project exists) untestable
without a real Postgres and a real spawned subprocess. Refactored into:

```
src/
  constants.ts         — every named value that would otherwise be a magic number/string
  config.ts             — the only module allowed to read process.env; fails fast at startup
  security/
    vault.ts             — AES-256-GCM for the credential vault (key injected, not read from env)
    apiKeys.ts           — API key generation/hashing (separate concern from vault encryption)
  db/
    types.ts             — plain domain types (Identity, UpstreamServer), no SQL shapes leak out
    pool.ts               — pg.Pool factory; nothing else creates its own connection
    IdentityRepository.ts | UpstreamServerRepository.ts | PermissionRepository.ts | AuditLogRepository.ts
                          — one repository per concern, each behind an interface
  gateway/
    UpstreamToolClient.ts — the minimal slice of the MCP SDK's Client that the handler needs
    summarizeResult.ts    — pure function, own unit tests
    ToolCallHandler.ts    — THE core policy (permission check → forward or deny → audit).
                            Depends only on the interfaces above, constructor-injected.
                            This is what makes it unit-testable with in-memory fakes.
  redact.ts             — unchanged, was already single-purpose
  index.ts              — composition root only: builds real Postgres-backed repositories
                          and a real MCP Client/Server, wires them into ToolCallHandler,
                          connects the transport. No business logic lives here.
```

Every repository is an interface + a `Postgres*` implementation — swapping storage later,
or using a fake in a test, means writing a new implementation of the same interface, not
touching `ToolCallHandler`.

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
- `test/integration/*.test.ts` (`npm run test:integration`) — the four `Postgres*Repository`
  classes against a real, migrated Postgres. Each test runs inside a transaction that's
  always rolled back (`test/integration/setupDatabase.ts`'s `withTransaction`), so tests
  can freely INSERT fixtures without leaving data behind or needing manual cleanup. This
  required loosening the repositories' constructors from `pg.Pool` to a minimal `Queryable`
  interface (`db/Queryable.ts`) — satisfied structurally by both `pg.Pool` and a
  transactional `pg.PoolClient`, so tests can hand in a client mid-transaction with zero
  changes to the repository code.
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
- `index.ts`'s wiring itself is still only covered by the manual smoke test
  (`scripts/manual_test_client.ts`), not automated — it's mostly composition (build real
  objects, connect a transport), lower-value to unit-test than the logic it wires together.

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

### Phase 3 (was Phase 2 — parity/hygiene, still worth doing, just not the differentiator)
- [ ] Replace static API keys with short-lived session tokens (issued after some login step)
      + rotation of the stored upstream credentials.
- [ ] Per-user (not just per-API-key) permission granularity, groundwork for real multi-tenant
      use.
- [ ] A way to actually read the audit log comfortably (CLI query tool at minimum; a small
      web view if it's worth it by then).

### Phase 4 (advanced, may not be worth doing — revisit after Phases 1-3 prove useful)
- [ ] Rollback/checkpoint hooks for known-destructive operation types (file writes, DB
      writes) — flagged in research as the hardest, most tool-specific problem; no
      general solution exists yet anywhere.

## Status log

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
