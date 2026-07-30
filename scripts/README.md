# scripts/

Operator tools and manual smoke tests. None of these are part of the running gateway —
each connects to Postgres (or a running gateway process) directly, run by hand when
needed. If you're just trying to use the gateway, you probably don't need anything here.

## Setup / operator tools (real, ongoing use)

- `migrate.ts` — applies every `migrations/*.sql` file not yet recorded in
  `schema_migrations`, in order. Safe to re-run any time.
- `seed_test_setup.ts` — provisions a throwaway identity + a filesystem server needing no
  credentials, for a first smoke test right after setup.
- `bootstrap_admin.ts` — grants one named, already-provisioned user the admin role.
  Deliberately manual, not run by any migration — see DESIGN.md for why.
- `seed_default_roles.ts` — idempotent: creates an `admin` role (empty) and a `developer`
  role with real servers, if they don't already exist.
- `set_user_credential.ts` — sets one user's own credential for a server, on their
  behalf. Most users should use the `register_my_credential` meta-tool themselves instead
  — this is for an operator setting it on someone else's.
- `view_audit_log.ts` — a filterable CLI over the audit trail.
- `lib/registerServer.ts`, `lib/provisionUser.ts` — shared helpers the scripts above (and
  the test suite) use to create real rows, not scripts you run directly.

## Manual smoke tests

Real but manual — not run by CI, no assertions of their own. Use these for a quick sanity
check against a real running process; see `test/e2e/` for the automated equivalent of
what these can cover.

- `manual_test_client.ts` — connects to the built stdio gateway like a real MCP client
  would: lists meta-tools, discovers a tool via `find_tool`, calls it via `call_tool`.
- `manual_test_http.ts` — the same, but for HTTP mode: logs in, then connects to `/mcp`
  with the session token. There's no automated equivalent yet — see DESIGN.md's backlog.
- `measure_context_overhead.ts` — the real measurement behind this project's "97.1%
  fewer tokens" claim (`gpt-tokenizer`'s actual encoding, not an estimate). Needs its own
  setup — see the script's own comment.
- `benchmark_gateway_overhead.ts` — a fuller token/latency benchmark across 4 real
  scenarios (happy path, catalog refresh, an embedding "miss" that needs a retry, and a
  direct-connection-with-no-gateway baseline) × {1, 2} servers × {Spanish, English}
  queries. Needs `GATEWAY_API_KEY`/`DATABASE_URL`/`GATEWAY_ENCRYPTION_KEY` for an identity
  permitted on real "jira" and "sonarqube" servers (only read-only tools are called —
  see the script's own plan). Writes `benchmark-results.json` and a self-contained
  `benchmark-report.html` (Chart.js via CDN, open directly in a browser) — both
  gitignored, regenerate rather than trust a stale copy. See DESIGN.md for what a real
  run found.
