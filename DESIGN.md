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

### Phase 2
- [ ] Replace static API keys with short-lived session tokens (issued after some login step)
      + rotation of the stored upstream credentials.
- [ ] Per-user (not just per-API-key) permission granularity, groundwork for real multi-tenant
      use.
- [ ] A way to actually read the audit log comfortably (CLI query tool at minimum; a small
      web view if it's worth it by then).

### Phase 3 (advanced, may not be worth doing — revisit after Phase 1/2 prove useful)
- [ ] Rollback/checkpoint hooks for known-destructive operation types (file writes, DB
      writes) — flagged in research as the hardest, most tool-specific problem; no
      general solution exists yet anywhere.

## Status log

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
