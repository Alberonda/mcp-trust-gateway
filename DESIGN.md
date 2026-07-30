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
                AdminToolHandler, buildAccessibleServerHandlers, cosineSimilarity,
                extractToolSummaries, types, constants, redact.
  ports/        interfaces adapters must implement — one per storage concern
                (*Repository), plus UpstreamToolClient, UpstreamConnectionProvider,
                CredentialVault, RateLimiter, RelayAgentRegistry, Embedder, Queryable.
  adapters/     concrete implementations, grouped by real technology:
                postgres/ (one Postgres* class per port, including tool_catalog),
                mcp/ (subprocess spawning), security/ (AES-256-GCM, api keys, session
                tokens), http/ (rate limiter), embeddings/ (LocalEmbedder — see "Semantic
                tool discovery" below), relay/ (dispatches execution to a connected relay
                agent instead of spawning locally — see "Relay agent" below).
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
│ 2. Build one handler per accessible server — connects to      │
│    NONE of them yet (see "Semantic tool discovery" below)      │
│ 3. Expose a small fixed set of meta-tools regardless of how    │
│    many real servers/tools sit behind it: find_tool, call_tool,│
│    list_services, register_my_credential, manage_roles (admin) │
│ 4. Per call: check permission → connect lazily (local          │
│    subprocess, or dispatched to a relay agent) → decrypt        │
│    credential → forward → write an audited, redacted log entry │
└──────────────────────────────────────────────────────────────┘
   ▼
Real MCP servers
```

Requires no changes to the agent or to upstream MCP servers — point an existing
MCP-compatible client's config at the gateway instead of directly at the real server.

### Semantic tool discovery + lazy connection

`find_tool` searches a *cached* `tool_catalog` table (name, description, embedding vector
per tool) via cosine similarity, instead of connecting live to every accessible server on
every session — see `ports/ToolCatalogRepository.ts` and `ports/Embedder.ts`.
`adapters/embeddings/LocalEmbedder.ts` runs a small (~90MB) sentence-embedding model
locally via `@huggingface/transformers` (measured ~1ms/embedding, no GPU, no external API
call, no data ever leaving the machine — see that adapter's own docstring).

- **The cache is what makes lazy connection possible, not the other way around.**
  `buildAccessibleServerHandlers.ts` builds one `ToolCallHandler` per accessible server
  without connecting to any of them; each handler's `UpstreamConnectionProvider` call is
  deferred to a lazy, memoized closure invoked only on that handler's own first real use.
  `ToolCallHandler.callTool` checks permission *before* ever invoking that closure — a
  denied call never connects at all, which is the actual fix for "every accessible server
  used to get a subprocess spawned for it at every session start, whether or not that
  session ever used it."
- A server with no cached catalog yet is the only case `find_tool` itself connects to
  anything (to learn what it offers at all — there's no way around that once). Otherwise,
  `call_tool`'s own connection opportunistically refreshes a stale entry
  (`TOOL_CATALOG_TTL_MS`, a week) in the background, reusing the same connection it
  already needed — never a second one just to refresh. `manage_roles`'s
  `refresh_catalog({serverName})` is the manual escape hatch for "I know it changed, don't
  wait for the TTL."
- **`find_tool` returns a global top-K (`MAX_FIND_TOOL_RESULTS`, 10), not an absolute
  similarity cutoff** — tried a cutoff first and found empirically, against a real ~90-
  tool catalog (Jira + SonarQube), that it barely filtered anything: ordinary English
  sentence embeddings share enough baseline structure that unrelated short strings often
  score noticeably above a "low" fixed threshold, so a real query like "quality gate
  sonar analysis" returned most of Jira's catalog alongside the genuinely relevant
  SonarQube tools. Re-verified against the same real catalog after switching to top-K:
  exactly 10 results, all SonarQube, topped by exact matches (`quality_gates`,
  `quality_gate`, `quality_gate_status`) — see this constant's own docstring for the
  research (LangChain's tool-retrieval pattern, the ToolReAGt paper, ToolScope/ToolScout)
  that converged on the same top-K approach before this was built.
- **Verified for real, twice**: once against the real Neon-backed deployment (Jira +
  SonarQube + a filesystem server, ~90 real tools) before finding the threshold problem
  above, and again after fixing it — the second `find_tool` call for the same query also
  ran in under half the time of the first (2.8s vs 5.6s), confirming the catalog cache
  is what made the second call skip reconnecting to anything.
- A real dependency-security finding worth recording: `@huggingface/transformers`
  pulled in transitive HIGH-severity advisories (`adm-zip` via `onnxruntime-node`,
  `sharp`'s bundled libvips) — neither reachable from this project's actual usage
  (`adm-zip` only runs inside onnxruntime-node's own install script against its own
  release archives, never a foreign ZIP at runtime; `sharp` is transformers.js's *image*
  input path, and this project only ever runs text pipelines) — fixed with `overrides`
  pinning both to their patched versions (`adm-zip@0.6.0`, `sharp@0.35.0`) rather than
  switching libraries, following the same fix a real, independently-published package
  (`@graphorin/embedder-transformersjs`) documents for the identical advisory chain.

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
not just intended behavior. 177 tests (116 unit, 57 integration, 4 e2e — see "Testing").

- **Governance across multiple servers**: an identity only discovers/calls tools on
  servers its roles grant, enforced identically whether reached via `find_tool` or
  `call_tool` directly.
- **Context cost stays flat**: `tools/list` exposes a small fixed meta-tool set
  regardless of how many real servers/tools sit behind it — 97.1% fewer tokens than a
  direct multi-server connection at N=2, measured with a real tokenizer.
- **Semantic tool discovery, connecting to nothing until actually needed**: `find_tool`
  ranks a cached catalog by local-embedding similarity (top-10 globally, not per server)
  instead of connecting live to every accessible server every session — see "Semantic
  tool discovery + lazy connection" above.
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
- [x] ~~`find_tool` only does substring matching, no semantic search~~ — done, see
      "Semantic tool discovery + lazy connection" above.
- [x] ~~Every accessible server connected at session start regardless of use~~ — done,
      same section (this fell out of the semantic-search change, not a separate one —
      connecting lazily was only possible once discovery stopped needing a live
      connection to search).
- [ ] TOCTOU window: a mid-flight permission revoke doesn't stop a call already in flight.
- [ ] No per-server error isolation for HTTP mode's relay path specifically — the local
      path already isolates failures naturally now (a lazy connection failure only ever
      affects the one call that triggered it); relay dispatch failures should behave the
      same way, not yet verified specifically.
- [ ] No connection pooling — each session that actually uses a server opens its own
      subprocess even if another identity is already connected to the same one.
- [ ] No master-key rotation path (only one server's stored credential at a time).
- [ ] Only one relay agent supported at a time; no admin visibility into which agents are
      connected or which servers currently have one.
- [x] ~~A real profiler, not just the one-off `measure_context_overhead.ts` script~~ —
      done 2026-07-30: `scripts/benchmark_gateway_overhead.ts`. Real sessions (not
      synthetic data) against real Jira/SonarQube, read-only tools only, across 4
      scenarios × {1, 2} servers × {es, en} queries, plus a no-gateway direct-connection
      baseline — writes `benchmark-results.json` + a self-contained
      `benchmark-report.html` (Chart.js via CDN).

      **Two real findings from an actual run**, not assumed:
      - **`catalog_refresh`'s background refresh is genuinely invisible to the caller,
        as designed** — the first `call_tool` against a server with an expired catalog
        entry measured 6.0–7.5s, statistically indistinguishable from the same call
        against an already-warm catalog (6.9–7.7s) across all four {server count ×
        language} combinations. Confirms `void this.refreshCatalogIfStale(...).catch(...)`
        (fire-and-forget, never awaited before responding — see
        `ToolDiscoveryRouter.callTool`) actually behaves the way its own docstring
        claims, not just in theory.
      - **A real embedding miss has a real, measurable cost**: deliberately oblique
        queries (e.g. "is everything okay today" for `system_ping`) missed the intended
        tool on the first `find_tool` call in most runs, forcing the simulated retry
        with clearer wording — adding 400-900 tokens and 0.7-2.6s per miss. Also found
        the retry itself sometimes missed too (an oblique-enough query can fail even a
        "good" rephrasing) — a genuine finding about `find_tool`'s real-world
        reliability, not a hypothetical worth dismissing.
      - **Direct connection (no gateway) costs 2-3x more tokens than the gateway's warm
        happy path** even at this project's modest real scale (~60-90 combined tools):
        23,997/29,861 tokens (1/2 servers) vs. 7,603/10,179 — a full `tools/list` dump
        vs. find_tool's ranked top-K, consistent with (and a second, independent
        confirmation of) the 97.1%-reduction claim `measure_context_overhead.ts`
        already established at N=2 servers with a smaller synthetic catalog.

      Real infra flakiness worth noting, not hidden: running this against a real hosted
      Postgres (Neon) surfaced transient "Connection terminated unexpectedly" errors
      from spawning many gateway sessions back-to-back — the pooled proxy needs a
      moment to recognize a just-closed connection as free. Fixed with a short cooldown
      between sessions and a retry-once-then-skip wrapper, rather than assuming
      real infrastructure behaves like a local one.

      **Real improvement points this run surfaced**, from the step-by-step breakdown,
      not just the totals:
      - **`find_tool` costs 700-2600ms even against an already-warm catalog** — far more
        than the ~1ms/embedding + one Postgres read the design assumed. Not yet root-
        caused: candidates are the embedding model's cold-start cost repeating on every
        fresh session (a new process per session today, no pooling — see below), Neon's
        network round-trip (a hosted, remote Postgres, not the low-latency local one
        integration tests use), or something else not yet isolated. Worth a real,
        instrumented breakdown before assuming which one it is.
      - **The dominant cost by far is the real upstream API call itself, not the
        gateway** — the first real `call_tool` against Jira/SonarQube took 7-9 seconds
        in BOTH direct and gateway modes, identically slow either way. This means
        "no connection pooling" (already in this backlog) would save less than
        previously assumed — pooling a connection doesn't make Jira itself answer
        faster. Re-scope that backlog item's expected payoff accordingly.
      - **The embedding-miss retry in this benchmark is more optimistic than real
        life**: it retries with a *known-good* query the benchmark script already had.
        A real agent has no such fallback — a genuine miss with no retry path might
        just fail to find the tool at all. Worth a real fallback layer (e.g. combining
        semantic ranking with a plain substring match as a second pass, so a tool whose
        name/keywords literally appear in the query is never missed purely on embedding
        similarity) rather than relying on an agent happening to rephrase well.
      - **Neon connection-pool exhaustion under rapid session churn might not be only a
        benchmark artifact** — HTTP mode serves genuinely concurrent real users, each
        opening their own Postgres pool's worth of connections on session start/end.
        Worth checking under real concurrent load, not just this benchmark's sequential
        one, before assuming it's fine.

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
