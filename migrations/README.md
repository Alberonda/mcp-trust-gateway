# migrations/

The real, executable schema — not documentation. Every file here is a real `.sql` script
already applied (or waiting to be applied) to a real database by `scripts/migrate.ts`,
which tracks what's already run in a `schema_migrations` table and only applies what's
new. Safe to re-run any time, including in CI (see `.github/workflows/ci.yml`).

Rules that keep this trustworthy:

- **Never edit a migration once it's been applied anywhere real.** If something needs to
  change, write a new migration that alters what the old one created — the numbered
  sequence is the actual history of every real database's schema, not a draft.
- **Number sequentially, one migration per real schema change.** Each file's own comment
  explains *why* that change happened — read a specific file for that, not this one.
- Applying a schema-dropping or schema-renaming migration to a shared database (e.g.
  Neon) while an already-deployed process still expects the old shape is a real hazard,
  not a hypothetical one — see DESIGN.md for an incident this caused. Redeploy the
  matching code immediately after migrating something shared, don't leave a window open.
